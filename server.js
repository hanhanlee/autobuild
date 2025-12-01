import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// --- 資料持久化設定 ---
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const JOBS_FILE = path.join(__dirname, 'jobs.json');

if (!fs.existsSync(PROJECTS_FILE)) {
    const initialProjects = [{
        id: 'proj_default_1',
        name: 'Example Project',
        description: '範例專案',
        commands: ['echo "Hello World"', 'sleep 2', 'echo "Done"']
    }];
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(initialProjects, null, 2));
}

const jobs = {};
if (fs.existsSync(JOBS_FILE)) {
    try {
        const savedJobs = JSON.parse(fs.readFileSync(JOBS_FILE));
        Object.assign(jobs, savedJobs);
        Object.values(jobs).forEach(job => {
            if (job.status === 'processing') {
                job.status = 'failed';
                job.logs.push('[System] Server restarted, job terminated unexpectedly.');
            }
        });
    } catch (e) {
        console.error('Failed to load jobs:', e);
    }
}

const activeProcesses = {};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'YOUR_EMAIL@gmail.com',
        pass: 'YOUR_APP_PASSWORD'
    }
});

function getProjects() { return JSON.parse(fs.readFileSync(PROJECTS_FILE)); }
function saveProjects(data) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2)); }
function saveJobs() { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); }

// --- APIs ---
app.get('/api/projects', (req, res) => res.json(getProjects()));
app.post('/api/projects', (req, res) => {
    const newProject = req.body;
    const projects = getProjects();
    const idx = projects.findIndex(p => p.id === newProject.id);
    if (idx >= 0) projects[idx] = newProject;
    else projects.push(newProject);
    saveProjects(projects);
    res.json({ success: true, projects });
});
app.delete('/api/projects/:id', (req, res) => {
    const projects = getProjects().filter(p => p.id !== req.params.id);
    saveProjects(projects);
    res.json({ success: true, projects });
});
app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).sort((a, b) => new Date(b.startTime) - new Date(a.startTime))));
app.get('/api/job/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});
app.post('/api/build', (req, res) => {
    const { projectId, projectName, commands, notificationEmails } = req.body;
    const jobId = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    jobs[jobId] = {
        id: jobId, projectId, projectName, status: 'pending', logs: [],
        startTime: new Date().toLocaleString(), notificationEmails
    };
    saveJobs();
    console.log(`[Job #${jobId}] Created for project: ${projectName}`);
    res.json({ success: true, jobId, message: 'Build initialized' });
    runBuildProcess(jobId, projectName, commands, notificationEmails);
});
app.post('/api/job/:id/cancel', (req, res) => {
    const jobId = req.params.id;
    const job = jobs[jobId];
    if (job && job.status === 'processing') {
        const child = activeProcesses[jobId];
        if (child) {
            child.kill(); 
            job.status = 'cancelled';
            job.logs.push(`[System] Build CANCELLED by user request.`);
            delete activeProcesses[jobId];
            saveJobs();
            res.json({ success: true, message: 'Job cancelled' });
        } else {
            res.status(400).json({ error: 'Process not found or already finished' });
        }
    } else {
        res.status(400).json({ error: 'Job is not running' });
    }
});

// --- 核心邏輯 ---
async function runBuildProcess(jobId, projectName, commands, emails) {
    const job = jobs[jobId];
    job.status = 'processing';
    saveJobs();
    
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const workspaceName = `${projectName}_${timestamp}`;
    const buildDir = path.join(__dirname, 'builds', workspaceName);

    const log = (msg) => {
        const time = new Date().toLocaleTimeString();
        const line = `[${time}] ${msg}`;
        job.logs.push(line);
    };

    try {
        log(`[System] Initializing build environment...`);
        if (!fs.existsSync(buildDir)){ fs.mkdirSync(buildDir, { recursive: true }); }
        log(`[System] Workspace created: ${buildDir}`);
        
        let currentCwd = buildDir;

        for (const command of commands) {
            if (job.status === 'cancelled') throw new Error('Build cancelled by user');
            log(`> ${command}`);
            
            const trimmedCmd = command.trim();
            if (trimmedCmd.startsWith('cd ')) {
                const targetPath = trimmedCmd.substring(3).trim();
                const newPath = path.resolve(currentCwd, targetPath);
                
                // --- DEBUG: 檢查目錄是否存在 ---
                if (fs.existsSync(newPath) && fs.lstatSync(newPath).isDirectory()) {
                    currentCwd = newPath;
                    log(`[System] Changed directory to: ${currentCwd}`);
                } else {
                    // 如果失敗，列出當前目錄下的檔案，幫助除錯
                    log(`[Debug Error] Target path not found: ${newPath}`);
                    log(`[Debug Error] Current dir (${currentCwd}) contains:`);
                    try {
                        const files = fs.readdirSync(currentCwd);
                        log(`[Debug Error] -> ${files.join(', ') || '(empty directory)'}`);
                    } catch (err) {
                        log(`[Debug Error] Could not list files: ${err.message}`);
                    }
                    throw new Error(`Directory not found: ${targetPath}`);
                }
            } else {
                await executeCommand(command, currentCwd, log, jobId);
            }
        }

        if (job.status !== 'cancelled') {
            job.status = 'completed';
            log(`[System] Build Completed Successfully.`);
            saveJobs();
            if (emails?.length) sendEmail(emails, `[SUCCESS] ${projectName} #${jobId}`, job.logs.join('\n'));
        }
    } catch (error) {
        if (job.status !== 'cancelled') {
            job.status = 'failed';
            log(`[Error] Build Failed: ${error.message}`);
            if (emails?.length) sendEmail(emails, `[FAILED] ${projectName} #${jobId}`, job.logs.join('\n'));
        }
        saveJobs();
    } finally {
        delete activeProcesses[jobId];
    }
}

function executeCommand(command, cwd, logFn, jobId) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, { 
            cwd, 
            shell: true,
            env: { ...process.env, CI: 'true' }
        });
        activeProcesses[jobId] = child;
        child.stdout.on('data', (data) => logFn(data.toString().trim()));
        child.stderr.on('data', (data) => logFn(data.toString().trim()));
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code ${code}`));
        });
        child.on('error', (err) => reject(err));
    });
}

async function sendEmail(to, subject, content) {
    try {
        await transporter.sendMail({
            from: '"Build System" <noreply@buildserver.com>',
            to: to.join(', '),
            subject: subject,
            text: `Logs attached.`,
            attachments: [{ filename: 'build.log', content: content }]
        });
    } catch (err) { console.error('Email error:', err); }
}

app.listen(PORT, () => {
    console.log(`Build Server running on http://localhost:${PORT}`);
});
