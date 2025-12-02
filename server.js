import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// --- 版本號設定 ---
const BACKEND_VERSION = 'v1.10 (Fix Workspace Record)';

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
    console.log(`[API] Scanning workspaces in: ${BUILDS_DIR}`);
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

// 修改：詳細路徑除錯 ROM 下載 API (強制 Headers)
app.get('/api/job/:id/download/rom', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).send('Job not found');
    
    console.log(`[Download] Request for Job #${job.id}`);

    // 嘗試修復舊資料：如果 workspaceDir 不存在但有 workspace 欄位 (舊版可能用這個名字)，則嘗試使用
    if (!job.workspaceDir && job.workspace && job.workspace !== '(New)') {
        console.log(`[Download] 'workspaceDir' missing, trying fallback to 'workspace': ${job.workspace}`);
        job.workspaceDir = job.workspace;
        // 嘗試存回，修正舊資料
        saveJobs();
    }

    if (!job.workspaceDir) {
        const msg = `Error: No 'workspaceDir' recorded for Job #${job.id}.\n` +
                    `This job might have been created before the update or failed to initialize properly.\n\n` +
                    `Job Data Dump:\n${JSON.stringify(job, null, 2)}`;
        console.error(`[Download Error] ${msg}`);
        return res.status(404).send(msg);
    }

    // Layer 1: Timestamp Directory
    const workspacePath = path.join(BUILDS_DIR, job.workspaceDir);
    if (!fs.existsSync(workspacePath)) {
        const msg = `Error: Workspace directory not found on server.\n` +
                    `Looking for: ${workspacePath}\n` + 
                    `This folder might have been deleted manually or via cleanup.`;
        console.error(`[Download Error] ${msg}`);
        return res.status(404).send(msg);
    }

    // Layer 2: Repository Directory
    let repoDirName;
    try {
        const contents = fs.readdirSync(workspacePath);
        repoDirName = contents.find(f => {
            const fullPath = path.join(workspacePath, f);
            return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
        });
    } catch (e) { console.error("Error reading timestamp dir:", e); }

    if (!repoDirName) return res.status(404).send('Repository directory not found in workspace');
    const repoDirPath = path.join(workspacePath, repoDirName);
    
    // Layer 3: Search for ROM
    let foundRomPath = null;
    let searchedPaths = [];

    try {
        const subDirs = fs.readdirSync(repoDirPath);
        for (const subDir of subDirs) {
            const potentialWorkspacePath = path.join(repoDirPath, subDir);
            if (!fs.statSync(potentialWorkspacePath).isDirectory()) continue;

            const potentialRom = path.join(potentialWorkspacePath, 'Build', 'output', 'rom.ima');
            searchedPaths.push(potentialRom);

            if (fs.existsSync(potentialRom)) {
                foundRomPath = potentialRom;
                break; 
            }
        }
    } catch (e) { console.error("Error searching for workspace dir:", e); }

    if (foundRomPath) {
        console.log(`[Download] Sending ROM: ${foundRomPath}`);
        
        const filename = `rom_${job.projectName}_${job.id}.ima`;
        
        // 關鍵修改：使用 sendFile 並明確設定 Header
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        res.sendFile(foundRomPath, (err) => {
            if (err) {
                console.error("Error sending file:", err);
                if (!res.headersSent) res.status(500).send("Error downloading file");
            }
        });
    } else {
        const msg = `Error: 'rom.ima' not found.\nSearched paths:\n${searchedPaths.join('\n')}`;
        console.log(`[Download Error] ${msg}`);
        res.status(404).send(msg);
    }
});

app.post('/api/build', (req, res) => {
    const { projectId, projectName, cloneCommands, buildCommands, notificationEmails, existingWorkspace } = req.body;
    const jobId = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    
    // 修正：確保初始化時就寫入 workspaceDir (如果是 Existing Workspace)
    // 如果是 New Workspace，稍後在 runBuildProcess 會更新，但先給個初始值或 null
    const initialWorkspace = existingWorkspace ? path.basename(existingWorkspace) : null;

    jobs[jobId] = {
        id: jobId, projectId, projectName, status: 'pending', logs: [],
        startTime: new Date().toLocaleString(), notificationEmails,
        workspaceDir: initialWorkspace, // 統一使用 workspaceDir 這個欄位名
        workspace: existingWorkspace || '(New)' // 舊欄位保留給前端顯示用
    };
    saveJobs();
    
    console.log(`[Job #${jobId}] Build initialized.`);
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

app.post('/api/cleanup', (req, res) => {
    const { type } = req.body; 
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    const newJobs = {};
    Object.keys(jobs).forEach(id => {
        const job = jobs[id];
        const jobTime = new Date(job.startTime);
        let shouldDelete = false;
        if (type === 'all' && job.status !== 'processing') shouldDelete = true;
        else if (type === 'old' && (now - jobTime) > SEVEN_DAYS_MS && job.status !== 'processing') shouldDelete = true;
        
        if (!shouldDelete) newJobs[id] = job; else deletedCount++;
    });
    jobs = newJobs; 
    saveJobs();

    if (fs.existsSync(BUILDS_DIR)) {
        const items = fs.readdirSync(BUILDS_DIR);
        items.forEach(item => {
            const itemPath = path.join(BUILDS_DIR, item);
            try {
                const stats = fs.statSync(itemPath);
                let shouldRemove = false;
                if (type === 'all') shouldRemove = true;
                else if (type === 'old' && (now - stats.mtime) > SEVEN_DAYS_MS) shouldRemove = true;
                if (shouldRemove) fs.rmSync(itemPath, { recursive: true, force: true });
            } catch (err) { console.error(`Failed to delete ${item}:`, err); }
        });
    }
    res.json({ success: true, message: `Cleaned up ${deletedCount} job records.` });
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
        log(`[System] Initializing build environment (Backend ${BACKEND_VERSION})...`);
        
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
        
        // 修正：確保 workspaceDir 在這裡被正確更新並存檔
        job.workspaceDir = workspaceName;
        // 同步更新顯示用的 workspace 欄位
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
