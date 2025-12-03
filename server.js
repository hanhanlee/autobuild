import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// --- 版本號設定 ---
const BACKEND_VERSION = 'v1.11 (Advanced Cleanup)';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// --- 全域 Request Logger ---
app.use((req, res, next) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

// --- 設定 ---
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const BUILDS_DIR = path.join(__dirname, 'builds');

if (!fs.existsSync(BUILDS_DIR)) {
    console.log(`[System] Creating builds directory at: ${BUILDS_DIR}`);
    fs.mkdirSync(BUILDS_DIR, { recursive: true });
}

if (!fs.existsSync(PROJECTS_FILE)) {
    const initialProjects = [{
        id: 'proj_default_1',
        name: 'Example Project',
        description: '範例專案',
        cloneCommands: ['echo "Cloning..."', 'git clone https://github.com/example/repo.git'],
        buildCommands: ['cd repo', 'npm install', 'npm run build']
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
        jobs = {};
    }
}

const activeProcesses = {};

const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', 
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
};
const transporter = nodemailer.createTransport(smtpConfig);

function getProjects() { 
    try { return JSON.parse(fs.readFileSync(PROJECTS_FILE)); } catch { return []; }
}
function saveProjects(data) { 
    try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error(e); }
}
function saveJobs() { 
    try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch(e) { console.error(e); }
}

function getDiskUsage(checkPath) {
    return new Promise((resolve) => {
        exec(`df -k "${checkPath}"`, (error, stdout) => {
            if (error) { resolve({ total: 0, used: 0, available: 0, percent: 0 }); return; }
            try {
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const parts = lastLine.replace(/\s+/g, ' ').split(' ');
                const total = parseInt(parts[1]) * 1024;
                const used = parseInt(parts[2]) * 1024;
                const percent = parts[4]; 
                resolve({ total, used, available: 0, percent });
            } catch (e) { resolve({ total: 0, used: 0, available: 0, percent: 0 }); }
        });
    });
}

// --- APIs ---

app.get('/api/projects', (req, res) => res.json(getProjects()));

app.post('/api/projects', (req, res) => {
    try {
        const newProject = req.body;
        if (!newProject.id || !newProject.name) throw new Error("Missing fields");
        if (!newProject.cloneCommands) newProject.cloneCommands = [];
        if (!newProject.buildCommands) newProject.buildCommands = [];
        
        const projects = getProjects();
        const idx = projects.findIndex(p => p.id === newProject.id);
        if (idx >= 0) projects[idx] = newProject; else projects.push(newProject);
        saveProjects(projects);
        res.json({ success: true, projects });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
    try {
        const projects = getProjects().filter(p => p.id !== req.params.id);
        saveProjects(projects);
        res.json({ success: true, projects });
    } catch (error) { res.status(500).json({ error: "Delete failed" }); }
});

app.get('/api/workspaces', (req, res) => {
    if (!fs.existsSync(BUILDS_DIR)) return res.json([]);
    try {
        const dirs = fs.readdirSync(BUILDS_DIR).filter(f => {
            try { return fs.statSync(path.join(BUILDS_DIR, f)).isDirectory(); } catch { return false; }
        }).map(f => {
            const stats = fs.statSync(path.join(BUILDS_DIR, f));
            return { name: f, time: stats.mtime };
        });
        dirs.sort((a, b) => new Date(b.time) - new Date(a.time));
        res.json(dirs);
    } catch (e) { res.status(500).json({ error: "List workspaces failed" }); }
});

app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).sort((a, b) => new Date(b.startTime) - new Date(a.startTime))));
app.get('/api/job/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

app.get('/api/job/:id/download/rom', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).send('Job not found');
    if (!job.workspaceDir) return res.status(404).send('No workspace recorded');

    const workspacePath = path.join(BUILDS_DIR, job.workspaceDir);
    if (!fs.existsSync(workspacePath)) return res.status(404).send('Workspace not found');

    let repoDirName;
    try {
        const contents = fs.readdirSync(workspacePath);
        repoDirName = contents.find(f => {
            const fullPath = path.join(workspacePath, f);
            return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
        });
    } catch (e) { console.error(e); }

    if (!repoDirName) return res.status(404).send('Repo dir not found');
    const repoDirPath = path.join(workspacePath, repoDirName);
    
    let foundRomPath = null;
    try {
        const subDirs = fs.readdirSync(repoDirPath);
        for (const subDir of subDirs) {
            const potentialRom = path.join(repoDirPath, subDir, 'Build', 'output', 'rom.ima');
            if (fs.existsSync(potentialRom)) {
                foundRomPath = potentialRom;
                break; 
            }
        }
    } catch (e) {}

    if (foundRomPath) {
        const filename = `rom_${job.projectName}_${job.id}.ima`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(foundRomPath);
    } else {
        res.status(404).send(`rom.ima not found`);
    }
});

app.post('/api/build', (req, res) => {
    const { projectId, projectName, cloneCommands, buildCommands, notificationEmails, existingWorkspace } = req.body;
    const jobId = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    const initialWorkspace = existingWorkspace ? path.basename(existingWorkspace) : null;

    jobs[jobId] = {
        id: jobId, projectId, projectName, status: 'pending', logs: [],
        startTime: new Date().toLocaleString(), notificationEmails,
        workspaceDir: initialWorkspace,
        workspace: existingWorkspace || '(New)'
    };
    saveJobs();
    
    res.json({ success: true, jobId, message: 'Build initialized' });
    runBuildProcess(jobId, projectName, cloneCommands, buildCommands, notificationEmails, existingWorkspace);
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
        } else { res.status(400).json({ error: 'Process not found' }); }
    } else { res.status(400).json({ error: 'Job is not running' }); }
});

app.get('/api/system/status', async (req, res) => {
    const disk = await getDiskUsage(BUILDS_DIR);
    res.json({ disk });
});

// 修改：支援 'specific', 'old' (with custom days), 'all'
app.post('/api/cleanup', (req, res) => {
    const { type, days, target } = req.body; 
    const now = new Date();
    
    // 計算天數閾值 (預設 7 天)
    const daysThreshold = parseInt(days) || 7;
    const MS_THRESHOLD = daysThreshold * 24 * 60 * 60 * 1000;
    
    let deletedCount = 0;
    let deletedFolders = 0;

    const newJobs = {};

    // 1. 清理 Jobs 記錄 (如果是刪除特定資料夾，也要把相關 Job 刪掉)
    Object.keys(jobs).forEach(id => {
        const job = jobs[id];
        const jobTime = new Date(job.startTime);
        let shouldDelete = false;

        if (job.status === 'processing') {
            // 正在執行的不刪
            shouldDelete = false;
        } else if (type === 'all') {
            shouldDelete = true;
        } else if (type === 'old') {
            if ((now - jobTime) > MS_THRESHOLD) shouldDelete = true;
        } else if (type === 'specific' && target) {
            // 如果 Job 的 workspaceDir 等於要刪除的目標，則移除紀錄
            if (job.workspaceDir === target) shouldDelete = true;
        }

        if (!shouldDelete) newJobs[id] = job;
        else deletedCount++;
    });
    jobs = newJobs; 
    saveJobs();

    // 2. 清理實體資料夾
    if (fs.existsSync(BUILDS_DIR)) {
        const items = fs.readdirSync(BUILDS_DIR);
        items.forEach(item => {
            const itemPath = path.join(BUILDS_DIR, item);
            try {
                const stats = fs.statSync(itemPath);
                let shouldRemove = false;

                if (type === 'all') {
                    shouldRemove = true;
                } else if (type === 'old') {
                    if ((now - stats.mtime) > MS_THRESHOLD) shouldRemove = true;
                } else if (type === 'specific' && target) {
                    if (item === target) shouldRemove = true;
                }

                if (shouldRemove) {
                    // 安全檢查：只刪除 BUILDS_DIR 下的內容，且必須是目錄
                    if (stats.isDirectory()) {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                        deletedFolders++;
                    }
                }
            } catch (err) { console.error(`Failed to delete ${item}:`, err); }
        });
    }

    res.json({ 
        success: true, 
        message: `清理完成。移除了 ${deletedCount} 筆紀錄，刪除了 ${deletedFolders} 個資料夾。` 
    });
});

async function runBuildProcess(jobId, projectName, cloneCommands, buildCommands, emails, existingWorkspaceName = null) {
    const job = jobs[jobId];
    job.status = 'processing';
    saveJobs();
    
    let workspaceName;
    let buildDir;

    const log = (msg) => {
        const time = new Date().toLocaleTimeString();
        const line = `[${time}] ${msg}`;
        if (jobs[jobId]) jobs[jobId].logs.push(line); 
    };

    try {
        log(`[System] Initializing build environment...`);
        
        if (existingWorkspaceName) {
            const safeName = path.basename(existingWorkspaceName);
            workspaceName = safeName;
            buildDir = path.join(BUILDS_DIR, safeName);
            if (!fs.existsSync(buildDir)) throw new Error(`Workspace not found: ${safeName}`);
            log(`[System] Using EXISTING workspace: ${buildDir}`);
        } else {
            const now = new Date();
            const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
            workspaceName = `${projectName}_${timestamp}`;
            buildDir = path.join(BUILDS_DIR, workspaceName);
            if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
            log(`[System] Created NEW workspace: ${buildDir}`);
        }
        
        job.workspaceDir = workspaceName;
        job.workspace = workspaceName;
        saveJobs();
        
        let currentCwd = buildDir;

        if (cloneCommands && cloneCommands.length > 0) {
            log(`[System] === Phase 1: Clone Source Code ===`);
            for (const command of cloneCommands) {
                if (!jobs[jobId] || jobs[jobId].status === 'cancelled') throw new Error('Build cancelled');
                log(`> ${command}`);
                const trimmedCmd = command.trim();
                if (trimmedCmd.startsWith('cd ')) {
                    const targetPath = trimmedCmd.substring(3).trim();
                    const newPath = path.resolve(currentCwd, targetPath);
                    if (fs.existsSync(newPath) && fs.lstatSync(newPath).isDirectory()) {
                        currentCwd = newPath;
                        log(`[System] Changed directory to: ${currentCwd}`);
                    } else throw new Error(`Directory not found: ${targetPath}`);
                } else await executeCommand(command, currentCwd, log, jobId);
            }
        }

        if (buildCommands && buildCommands.length > 0) {
            log(`[System] === Phase 2: Build Project ===`);
            for (const command of buildCommands) {
                if (!jobs[jobId] || jobs[jobId].status === 'cancelled') throw new Error('Build cancelled');
                log(`> ${command}`);
                const trimmedCmd = command.trim();
                if (trimmedCmd.startsWith('cd ')) {
                    const targetPath = trimmedCmd.substring(3).trim();
                    const newPath = path.resolve(currentCwd, targetPath);
                    if (fs.existsSync(newPath) && fs.lstatSync(newPath).isDirectory()) {
                        currentCwd = newPath;
                        log(`[System] Changed directory to: ${currentCwd}`);
                    } else throw new Error(`Directory not found: ${targetPath}`);
                } else await executeCommand(command, currentCwd, log, jobId);
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
    } finally { delete activeProcesses[jobId]; }
}

function executeCommand(command, cwd, logFn, jobId) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: 'true' } });
        activeProcesses[jobId] = child;
        child.stdout.on('data', (data) => logFn(data.toString().trim()));
        child.stderr.on('data', (data) => logFn(data.toString().trim()));
        child.on('close', (code) => {
            if (code === 0) resolve(); else reject(new Error(`Exit code ${code}`));
        });
        child.on('error', (err) => reject(err));
    });
}

async function sendEmail(to, subject, content) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    try {
        await transporter.sendMail({
            from: `"Build System" <${process.env.SMTP_USER}>`, 
            to: to.join(', '), subject, text: `Logs attached.`,
            attachments: [{ filename: 'build.log', content: content }]
        });
    } catch (err) { console.error('Email error:', err); }
}

app.listen(PORT, () => console.log(`[v${BACKEND_VERSION}] Build Server running on http://localhost:${PORT}`));
