import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv'; // 新增：引入 dotenv

// 讀取 .env 設定
dotenv.config();

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

let jobs = {}; 
if (fs.existsSync(JOBS_FILE)) {
    try {
        const savedJobs = JSON.parse(fs.readFileSync(JOBS_FILE));
        jobs = savedJobs; 
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

// --- Email 設定 (改為讀取環境變數) ---
// 如果 .env 沒設定，會嘗試 fallback 到預設值或報錯
const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
};

// 只有在有設定帳號密碼時才啟用 auth
if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("⚠️  警告: 未設定 SMTP_USER 或 SMTP_PASS，郵件功能可能無法運作。請檢查 .env 檔案。");
}

const transporter = nodemailer.createTransport(smtpConfig);

function getProjects() { return JSON.parse(fs.readFileSync(PROJECTS_FILE)); }
function saveProjects(data) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2)); }
function saveJobs() { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); }

// --- Helper: 取得硬碟空間 ---
function getDiskUsage(checkPath) {
    return new Promise((resolve) => {
        exec(`df -k "${checkPath}"`, (error, stdout) => {
            if (error) {
                resolve({ total: 0, used: 0, available: 0, percent: 0 });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const parts = lastLine.replace(/\s+/g, ' ').split(' ');
                
                const total = parseInt(parts[1]) * 1024;
                const used = parseInt(parts[2]) * 1024;
                const available = parseInt(parts[3]) * 1024;
                const percent = parts[4]; 
                
                resolve({ total, used, available, percent });
            } catch (e) {
                resolve({ total: 0, used: 0, available: 0, percent: 0 });
            }
        });
    });
}

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

app.get('/api/system/status', async (req, res) => {
    const buildDir = path.join(__dirname, 'builds');
    if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
    const disk = await getDiskUsage(buildDir);
    res.json({ disk });
});

app.post('/api/cleanup', (req, res) => {
    const { type } = req.body; 
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    
    const buildDir = path.join(__dirname, 'builds');
    let deletedCount = 0;

    const newJobs = {};
    Object.keys(jobs).forEach(id => {
        const job = jobs[id];
        const jobTime = new Date(job.startTime);
        let shouldDelete = false;

        if (type === 'all') {
            if (job.status !== 'processing') shouldDelete = true;
        } else if (type === 'old') {
            if ((now - jobTime) > SEVEN_DAYS_MS && job.status !== 'processing') {
                shouldDelete = true;
            }
        }

        if (!shouldDelete) {
            newJobs[id] = job;
        } else {
            deletedCount++;
        }
    });
    
    jobs = newJobs; 
    saveJobs();

    if (fs.existsSync(buildDir)) {
        const items = fs.readdirSync(buildDir);
        items.forEach(item => {
            const itemPath = path.join(buildDir, item);
            try {
                const stats = fs.statSync(itemPath);
                let shouldRemove = false;

                if (type === 'all') {
                    shouldRemove = true;
                } else if (type === 'old') {
                    if ((now - stats.mtime) > SEVEN_DAYS_MS) {
                        shouldRemove = true;
                    }
                }

                if (shouldRemove) {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                }
            } catch (err) {
                console.error(`Failed to delete ${item}:`, err);
            }
        });
    }

    res.json({ success: true, message: `Cleaned up ${deletedCount} job records.` });
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
        if (jobs[jobId]) jobs[jobId].logs.push(line); 
    };

    try {
        log(`[System] Initializing build environment...`);
        if (!fs.existsSync(buildDir)){ fs.mkdirSync(buildDir, { recursive: true }); }
        log(`[System] Workspace created: ${buildDir}`);
        
        let currentCwd = buildDir;

        for (const command of commands) {
            if (!jobs[jobId] || jobs[jobId].status === 'cancelled') throw new Error('Build cancelled by user');
            log(`> ${command}`);
            
            const trimmedCmd = command.trim();
            if (trimmedCmd.startsWith('cd ')) {
                const targetPath = trimmedCmd.substring(3).trim();
                const newPath = path.resolve(currentCwd, targetPath);
                
                if (fs.existsSync(newPath) && fs.lstatSync(newPath).isDirectory()) {
                    currentCwd = newPath;
                    log(`[System] Changed directory to: ${currentCwd}`);
                } else {
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

        if (jobs[jobId] && jobs[jobId].status !== 'cancelled') {
            jobs[jobId].status = 'completed';
            log(`[System] Build Completed Successfully.`);
            saveJobs();
            if (emails?.length) sendEmail(emails, `[SUCCESS] ${projectName} #${jobId}`, jobs[jobId].logs.join('\n'));
        }
    } catch (error) {
        if (jobs[jobId]) {
            if (jobs[jobId].status !== 'cancelled') {
                jobs[jobId].status = 'failed';
                log(`[Error] Build Failed: ${error.message}`);
                if (emails?.length) sendEmail(emails, `[FAILED] ${projectName} #${jobId}`, jobs[jobId].logs.join('\n'));
            }
            saveJobs();
        }
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
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log('[Mock Email] Skipping email because SMTP credentials are missing.');
        return;
    }
    try {
        await transporter.sendMail({
            from: `"Build System" <${process.env.SMTP_USER}>`, // 使用 .env 設定的 Email
            to: to.join(', '),
            subject: subject,
            text: `Logs attached.`,
            attachments: [{ filename: 'build.log', content: content }]
        });
        console.log(`[System] Email sent to ${to.join(', ')}`);
    } catch (err) { console.error('Email error:', err); }
}

app.listen(PORT, () => {
    console.log(`Build Server running on http://localhost:${PORT}`);
});
