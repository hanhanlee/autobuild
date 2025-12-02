import React, { useState, useEffect, useRef } from 'react';
import { Play, Clock, CheckCircle, XCircle, Terminal, Loader2, RefreshCw, Trash2, Server, Plus, X, Save, Pencil, Download, Mail, ChevronRight, AlertTriangle, Square, Folder, HardDrive, GitBranch, Hammer, Repeat, RefreshCcw, FileDown } from 'lucide-react';

// --- 版本號設定 ---
const FRONTEND_VERSION = 'v1.08 (ROM Download)';

// --- 自動偵測 API 位址 ---
const API_BASE_URL = `http://${window.location.hostname}:3001/api`;

// --- 模擬資料 ---
const MOCK_PROJECTS = [
  {
    id: 'mock_proj_1',
    name: 'Demo_ECommerce_Web',
    description: '範例電商平台 (Demo Mode)',
    cloneCommands: ['echo "Cloning..."', 'git clone https://github.com/demo/ecommerce.git'],
    buildCommands: ['npm install', 'npm run build']
  },
  {
    id: 'mock_proj_2',
    name: 'Demo_Backend_API',
    description: '範例後端服務 (Demo Mode)',
    cloneCommands: ['git clone https://github.com/demo/api.git'],
    buildCommands: ['docker build -t api-service .']
  }
];

// --- 狀態標籤組件 ---
const StatusBadge = ({ status }) => {
  const styles = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    processing: 'bg-blue-100 text-blue-800 border-blue-200',
    completed: 'bg-green-100 text-green-800 border-green-200',
    failed: 'bg-red-100 text-red-800 border-red-200',
    cancelled: 'bg-gray-100 text-gray-600 border-gray-300',
  };
  const icons = {
    pending: <Clock className="w-4 h-4 mr-1" />,
    processing: <Loader2 className="w-4 h-4 mr-1 animate-spin" />,
    completed: <CheckCircle className="w-4 h-4 mr-1" />,
    failed: <XCircle className="w-4 h-4 mr-1" />,
    cancelled: <XCircle className="w-4 h-4 mr-1" />,
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status] || 'bg-gray-100'}`}>
      {icons[status]} {status}
    </span>
  );
};

const DiskUsageBar = ({ stats }) => {
    if (!stats) return null;
    const toGB = (bytes) => (bytes / (1024 * 1024 * 1024)).toFixed(1);
    const totalGB = toGB(stats.total);
    const usedGB = toGB(stats.used);
    const percent = parseFloat(stats.percent);
    let color = 'bg-green-500';
    if (percent > 70) color = 'bg-yellow-500';
    if (percent > 90) color = 'bg-red-500';
    return (
        <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-600">
                <span className="flex items-center"><HardDrive className="w-3 h-3 mr-1"/> Disk Usage</span>
                <span>{usedGB} / {totalGB} GB ({stats.percent})</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                <div className={`h-2 rounded-full ${color} transition-all duration-500`} style={{ width: stats.percent }}></div>
            </div>
        </div>
    );
};

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [buildQueue, setBuildQueue] = useState([]);
  const [notificationEmails, setNotificationEmails] = useState('');
  const [serverError, setServerError] = useState(null);
  const [diskStats, setDiskStats] = useState(null);
  
  const [activeTab, setActiveTab] = useState('new');
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceError, setWorkspaceError] = useState(null);
  const [workspaceErrorDetail, setWorkspaceErrorDetail] = useState(null);

  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [runCloneStage, setRunCloneStage] = useState(true);
  const [runBuildStage, setRunBuildStage] = useState(true);
  
  const [activeJobId, setActiveJobId] = useState(null);
  const logEndRef = useRef(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newProjectForm, setNewProjectForm] = useState({ name: '', description: '', cloneCommands: '', buildCommands: '' });

  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || {};
  const viewingJob = buildQueue.find(job => job.id === activeJobId) || buildQueue[0];
  const isWorkerRunning = buildQueue.some(job => job.status === 'processing');
  const jobWorkspacePath = viewingJob?.logs?.find(l => l && l.includes('Workspace created:'))?.split('created: ')[1]?.trim() 
                        || viewingJob?.logs?.find(l => l && l.includes('EXISTING workspace:'))?.split('workspace: ')[1]?.trim();

  const filteredWorkspaces = workspaces;

  // --- 1. 定義 API 函式 ---
  
  const fetchProjects = async () => {
    try {
        const res = await fetch(`${API_BASE_URL}/projects`);
        if (!res.ok) throw new Error('Network error');
        const data = await res.json();
        setProjects(data);
        setProjects(prev => {
            if (data.length > 0 && !selectedProjectId) setSelectedProjectId(data[0].id);
            return data;
        });
        setServerError(null);
    } catch (e) { setServerError("無法連接後端 (Projects)"); }
  };

  const fetchJobs = async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/jobs`);
          if (res.ok) setBuildQueue(await res.json());
      } catch (e) { console.warn("Fetch jobs failed"); }
  };

  const fetchWorkspaces = async () => {
      console.log(`[Frontend] Fetching workspaces from: ${API_BASE_URL}/workspaces`);
      setWorkspaceError(null);
      setWorkspaceErrorDetail(null);
      try {
          const res = await fetch(`${API_BASE_URL}/workspaces`);
          if (res.ok) {
              const data = await res.json();
              setWorkspaces(data);
          } else {
              const errorText = await res.text();
              setWorkspaceErrorDetail(errorText);
              let displayMsg = `HTTP ${res.status}`;
              if (errorText.includes('<!DOCTYPE html>')) {
                  const preMatch = errorText.match(/<pre>(.*?)<\/pre>/i);
                  if (preMatch) {
                      displayMsg += `: ${preMatch[1]}`;
                  } else {
                      const titleMatch = errorText.match(/<title>(.*?)<\/title>/i);
                      displayMsg += titleMatch ? `: ${titleMatch[1]}` : ": HTML Error";
                  }
              } else {
                  displayMsg += `: ${errorText.substring(0, 50)}`;
              }
              setWorkspaceError(displayMsg);
          }
      } catch (e) { 
          setWorkspaceError(`Conn Failed: ${e.message}`);
          setWorkspaceErrorDetail(e.toString());
      }
  };

  const fetchSystemStatus = async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/system/status`);
          if (res.ok) {
              const data = await res.json();
              setDiskStats(data.disk);
          }
      } catch(e) { console.warn("Fetch disk status failed"); }
  };

  // --- 2. 初始化流程 ---
  useEffect(() => {
    const initData = async () => {
        try {
            console.log(`[Frontend] Connecting to API: ${API_BASE_URL}`);
            const projRes = await fetch(`${API_BASE_URL}/projects`);
            if (!projRes.ok) throw new Error("Connection failed");
            const projs = await projRes.json();
            setProjects(projs);
            if (projs.length > 0 && !selectedProjectId) setSelectedProjectId(projs[0].id);
            setServerError(null);

            fetchJobs();
            fetchSystemStatus();
            fetchWorkspaces();
        } catch (e) {
            console.warn("Initialization failed, switching to DEMO mode:", e);
            setServerError(`無法連接後端 (${API_BASE_URL})`);
            setProjects(MOCK_PROJECTS);
            setSelectedProjectId(MOCK_PROJECTS[0].id);
            setDiskStats({ total: 500 * 1024 * 1024 * 1024, used: 120 * 1024 * 1024 * 1024, percent: "24%" });
        }
    };
    initData();
  }, []);

  // --- Polling ---
  useEffect(() => {
    if (serverError) return;
    const intervalId = setInterval(async () => {
      const activeJobs = buildQueue.filter(job => ['processing', 'pending'].includes(job.status));
      if (new Date().getSeconds() % 5 === 0) fetchSystemStatus();
      if (activeJobs.length === 0) return;

      for (const job of activeJobs) {
        try {
          const response = await fetch(`${API_BASE_URL}/job/${job.id}`);
          if (response.ok) {
            const updatedJob = await response.json();
            setBuildQueue(prev => prev.map(item => item.id === updatedJob.id ? updatedJob : item));
          }
        } catch (error) { console.warn("Polling skipped"); }
      }
    }, 2000);
    return () => clearInterval(intervalId);
  }, [buildQueue, serverError]);

  useEffect(() => {
    if (viewingJob && viewingJob.status === 'processing') {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [buildQueue, viewingJob]);

  // --- Actions ---
  const handleStartBuild = async () => {
    if (!selectedProject || !selectedProject.id) return;
    const emailList = notificationEmails.split(',').map(e => e.trim()).filter(e => e);
    
    if (serverError) {
        const mockJobId = `job_${Date.now()}`;
        const newJob = {
             id: mockJobId, projectId: selectedProject.id, projectName: selectedProject.name,
             status: 'pending', startTime: new Date().toLocaleString(),
             logs: ['[System] Queueing (Local Demo)...'], notificationEmails: emailList
        };
        setBuildQueue(prev => [newJob, ...prev]);
        setActiveJobId(mockJobId);
        return;
    }

    let payload = {
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        notificationEmails: emailList,
        cloneCommands: [],
        buildCommands: [],
        existingWorkspace: null
    };

    if (activeTab === 'new') {
        if (runCloneStage) payload.cloneCommands = selectedProject.cloneCommands;
        if (runBuildStage) payload.buildCommands = selectedProject.buildCommands;
    } else {
        if (!selectedWorkspace) {
            alert("請選擇一個現有的 Codebase 資料夾");
            return;
        }
        payload.existingWorkspace = selectedWorkspace;
        if (runCloneStage) payload.cloneCommands = selectedProject.cloneCommands;
        if (runBuildStage) payload.buildCommands = selectedProject.buildCommands;
    }

    if (payload.cloneCommands.length === 0 && payload.buildCommands.length === 0) {
        alert("請至少選擇一個執行階段 (Clone 或 Build)");
        return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        const data = await response.json();
        const newJob = {
             id: data.jobId, projectId: selectedProject.id, projectName: selectedProject.name,
             status: 'pending', startTime: new Date().toLocaleString(),
             logs: ['[System] Queueing...'], notificationEmails: emailList
        };
        setBuildQueue(prev => [newJob, ...prev]);
        setActiveJobId(data.jobId);
        if (activeTab === 'new') setTimeout(fetchWorkspaces, 2000);
      } else { alert("啟動失敗"); }
    } catch (e) { alert("啟動失敗：連線錯誤"); }
  };

  const handleCancelBuild = async (jobId, e) => {
      e.stopPropagation();
      if (!window.confirm("確定要中止這個任務嗎？")) return;
      if (serverError) {
          setBuildQueue(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
          return;
      }
      try {
          await fetch(`${API_BASE_URL}/job/${jobId}/cancel`, { method: 'POST' });
          setBuildQueue(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
      } catch (e) { alert("連線錯誤"); }
  };

  const handleCleanup = async (type) => {
      if (!window.confirm(type === 'all' ? "警告：刪除所有紀錄？" : "刪除 >7 天舊紀錄？")) return;
      if (serverError) { setBuildQueue([]); return; }
      try {
          const res = await fetch(`${API_BASE_URL}/cleanup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type })
          });
          if (res.ok) {
              const data = await res.json();
              alert(data.message);
              fetchJobs(); fetchSystemStatus(); fetchWorkspaces();
          }
      } catch (e) { alert("清理失敗"); }
  };

  const handleSaveProject = async (e) => {
    e.preventDefault();
    if (!newProjectForm.name) return;
    
    try {
        const cloneCmds = (newProjectForm.cloneCommands || '').split('\n').filter(l => l.trim());
        const buildCmds = (newProjectForm.buildCommands || '').split('\n').filter(l => l.trim());
        
        const projectData = {
            id: isEditing ? selectedProjectId : `proj_${Date.now()}`,
            name: newProjectForm.name,
            description: newProjectForm.description,
            cloneCommands: cloneCmds,
            buildCommands: buildCmds
        };

        if (serverError) {
            if (isEditing) {
                setProjects(prev => prev.map(p => p.id === selectedProjectId ? projectData : p));
            } else {
                setProjects(prev => [...prev, projectData]);
                setSelectedProjectId(projectData.id);
            }
            setIsModalOpen(false);
            setNewProjectForm({ name: '', description: '', cloneCommands: '', buildCommands: '' });
            return;
        }

        const res = await fetch(`${API_BASE_URL}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectData)
        });
        
        if (res.ok) {
            await fetchProjects();
            if (!isEditing) setSelectedProjectId(projectData.id);
            setIsModalOpen(false);
            setNewProjectForm({ name: '', description: '', cloneCommands: '', buildCommands: '' });
        } else {
            const errData = await res.json();
            throw new Error(errData.error || `HTTP ${res.status}`);
        }
    } catch(e) { 
        alert("儲存失敗: " + e.message); 
    }
  };

  const handleDeleteProject = async () => {
      if (!selectedProjectId || !window.confirm("確定刪除此專案？")) return;
      if (serverError) {
          const remaining = projects.filter(p => p.id !== selectedProjectId);
          setProjects(remaining);
          if (remaining.length > 0) setSelectedProjectId(remaining[0].id); else setSelectedProjectId('');
          return;
      }
      try {
          const res = await fetch(`${API_BASE_URL}/projects/${selectedProjectId}`, { method: 'DELETE' });
          if (res.ok) { await fetchProjects(); setSelectedProjectId(''); }
      } catch(e) { alert("刪除失敗"); }
  };

  const openCreateModal = () => { setIsEditing(false); setNewProjectForm({ name: '', description: '', cloneCommands: '', buildCommands: '' }); setIsModalOpen(true); };
  const openEditModal = () => {
    if (!selectedProject.id) return;
    setIsEditing(true);
    setNewProjectForm({ 
        name: selectedProject.name, 
        description: selectedProject.description, 
        cloneCommands: (selectedProject.cloneCommands || []).join('\n'),
        buildCommands: (selectedProject.buildCommands || []).join('\n')
    });
    setIsModalOpen(true);
  };
  const handleClearHistory = () => setBuildQueue([]); 
  const handleDownloadLogs = () => { 
    if(!viewingJob?.logs) return;
    const blob = new Blob([viewingJob.logs.join('\n')], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `log_${viewingJob.id}.txt`; link.click();
  };

  // --- 新增：下載 ROM ---
  const handleDownloadRom = () => {
      if (!viewingJob?.id) return;
      // 透過開啟新視窗/轉址來觸發瀏覽器下載
      window.location.href = `${API_BASE_URL}/job/${viewingJob.id}/download/rom`;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {serverError && <div className="bg-red-600 text-white px-4 py-2 text-sm text-center font-bold flex justify-center items-center"><AlertTriangle className="mr-2 w-4 h-4"/>{serverError} - 請確認後端 (node server.js) 已啟動</div>}

      {/* Modal ... (省略，無變動) */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-bold text-lg text-slate-800">{isEditing ? '編輯' : '新增'}客戶專案</h3>
              <button onClick={() => setIsModalOpen(false)}><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <form onSubmit={handleSaveProject} className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-500">專案名稱</label>
                      <input className="w-full border p-2 rounded" placeholder="專案名稱" value={newProjectForm.name} onChange={e => setNewProjectForm({...newProjectForm, name: e.target.value})} required />
                  </div>
                  <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-500">描述</label>
                      <input className="w-full border p-2 rounded" placeholder="描述" value={newProjectForm.description} onChange={e => setNewProjectForm({...newProjectForm, description: e.target.value})} />
                  </div>
              </div>
              
              <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-500 flex items-center"><GitBranch className="w-3 h-3 mr-1"/> Clone 指令 (Git Clone...)</label>
                  <textarea className="w-full h-24 border p-2 rounded font-mono text-sm bg-slate-900 text-cyan-400" placeholder="git clone https://..." value={newProjectForm.cloneCommands} onChange={e => setNewProjectForm({...newProjectForm, cloneCommands: e.target.value})} />
              </div>

              <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-500 flex items-center"><Hammer className="w-3 h-3 mr-1"/> Build 指令 (Compile, Test...)</label>
                  <textarea className="w-full h-32 border p-2 rounded font-mono text-sm bg-slate-900 text-green-400" placeholder="npm install&#10;npm run build" value={newProjectForm.buildCommands} onChange={e => setNewProjectForm({...newProjectForm, buildCommands: e.target.value})} />
              </div>

              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 border p-2 rounded">取消</button>
                <button type="submit" className="flex-1 bg-indigo-600 text-white p-2 rounded">儲存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Header ... (省略，無變動) */}
      <header className="bg-white shadow-sm border-b h-16 flex items-center px-8 justify-between">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg"><Server className="text-white w-6 h-6"/></div>
            <div>
              <h1 className="text-xl font-bold">內部 Build 驗證系統</h1>
              <p className="text-xs text-slate-500 font-mono">Frontend: {FRONTEND_VERSION}</p>
            </div>
        </div>
        <div className="flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-full text-sm text-slate-500">
            <div className={`w-2 h-2 rounded-full ${isWorkerRunning ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}`}></div>
            Build Server: {serverError ? 'Disconnected' : 'Connected'}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* 左側面板 ... (省略，無變動) */}
        <div className="lg:col-span-1 space-y-6">
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                {/* 頁籤切換 */}
                <div className="flex border-b border-slate-200">
                    <button 
                        onClick={() => { 
                            console.log('[UI] Switched to NEW Build tab'); 
                            setActiveTab('new'); 
                            // 切換到 New Tab 時，預設全部勾選
                            setRunCloneStage(true);
                            setRunBuildStage(true);
                        }}
                        className={`flex-1 py-3 text-sm font-medium flex items-center justify-center ${activeTab === 'new' ? 'bg-white text-indigo-600 border-b-2 border-indigo-600' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                    >
                        <Play className="w-4 h-4 mr-2"/> 啟動新 Build
                    </button>
                    <button 
                        onClick={() => { 
                            console.log('[UI] Switched to EXISTING Codebase tab'); 
                            setActiveTab('existing'); 
                            fetchWorkspaces(); 
                            // 切換到 Existing Tab 時，預設不勾 Clone (通常已經 Clone 了)
                            setRunCloneStage(false);
                            setRunBuildStage(true);
                        }}
                        className={`flex-1 py-3 text-sm font-medium flex items-center justify-center ${activeTab === 'existing' ? 'bg-white text-indigo-600 border-b-2 border-indigo-600' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                    >
                        <Repeat className="w-4 h-4 mr-2"/> 現有 Codebase
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    {/* 共用：選擇專案 (專案CRUD) */}
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">選擇客戶專案</label>
                        <div className="flex items-center space-x-2 max-w-full">
                            <select value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)} className="flex-1 border rounded p-2 text-sm min-w-0">
                                {projects.length > 0 ? projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>) : <option>Loading...</option>}
                            </select>
                            <button onClick={openEditModal} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-100 disabled:opacity-50"><Pencil className="w-4 h-4"/></button>
                            <button onClick={openCreateModal} className="p-2 border rounded hover:bg-slate-100 text-indigo-600"><Plus className="w-4 h-4"/></button>
                            <button onClick={handleDeleteProject} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-100 text-red-600 disabled:opacity-50"><Trash2 className="w-4 h-4"/></button>
                        </div>
                        <p className="mt-2 text-xs text-slate-500 min-h-[1.5em]">{selectedProject.description || (serverError ? '連線中斷 - 展示模式' : '請選擇或建立專案')}</p>
                    </div>

                    {/* === 頁籤內容：啟動新 Build === */}
                    {activeTab === 'new' && (
                        <>
                            {/* 新增：階段選擇 (New Build) */}
                            <div className="bg-white border rounded p-3 space-y-2 mb-3">
                                <span className="text-xs font-semibold text-slate-500">選擇執行階段</span>
                                <label className="flex items-center space-x-2 text-sm cursor-pointer">
                                    <input type="checkbox" checked={runCloneStage} onChange={e => setRunCloneStage(e.target.checked)} className="rounded text-indigo-600"/>
                                    <span>Clone Stage (抓取程式碼)</span>
                                </label>
                                <label className="flex items-center space-x-2 text-sm cursor-pointer">
                                    <input type="checkbox" checked={runBuildStage} onChange={e => setRunBuildStage(e.target.checked)} className="rounded text-indigo-600"/>
                                    <span>Build Stage (編譯建置)</span>
                                </label>
                            </div>

                            <div className="bg-slate-800 rounded p-3 text-xs font-mono space-y-3 overflow-hidden">
                                {runCloneStage && (
                                    <div>
                                        <div className="text-slate-500 mb-1 flex items-center"><GitBranch className="w-3 h-3 mr-1"/> Clone Stage:</div>
                                        <div className="text-cyan-400 pl-2 border-l border-slate-600">
                                            {(selectedProject.cloneCommands || []).length > 0 
                                                ? selectedProject.cloneCommands.map((cmd, i) => <div key={i}>$ {cmd}</div>)
                                                : <span className="text-slate-600 italic">No commands</span>}
                                        </div>
                                    </div>
                                )}
                                {runBuildStage && (
                                    <div>
                                        <div className="text-slate-500 mb-1 flex items-center"><Hammer className="w-3 h-3 mr-1"/> Build Stage:</div>
                                        <div className="text-green-400 pl-2 border-l border-slate-600">
                                            {(selectedProject.buildCommands || []).length > 0 
                                                ? selectedProject.buildCommands.map((cmd, i) => <div key={i}>$ {cmd}</div>)
                                                : <span className="text-slate-600 italic">No commands</span>}
                                        </div>
                                    </div>
                                )}
                                {!runCloneStage && !runBuildStage && (
                                    <div className="text-slate-500 italic text-center">未選擇任何執行階段</div>
                                )}
                            </div>
                        </>
                    )}

                    {/* === 頁籤內容：現有 Codebase === */}
                    {activeTab === 'existing' && (
                        <div className="space-y-4">
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="block text-sm font-medium text-slate-700">選擇現有 Workspace</label>
                                    <button onClick={fetchWorkspaces} className="text-xs flex items-center text-blue-600 hover:underline"><RefreshCcw className="w-3 h-3 mr-1"/>重新整理</button>
                                </div>
                                <select 
                                    value={selectedWorkspace} 
                                    onChange={e => setSelectedWorkspace(e.target.value)} 
                                    className="w-full border rounded p-2 text-sm bg-yellow-50 border-yellow-200"
                                >
                                    <option value="">-- 請選擇 --</option>
                                    {filteredWorkspaces.length > 0 ? (
                                        filteredWorkspaces.map(w => (
                                            <option key={w.name} value={w.name}>
                                                {w.name} ({new Date(w.time).toLocaleString()})
                                            </option>
                                        ))
                                    ) : (
                                        <option disabled>無相關紀錄</option>
                                    )}
                                </select>
                                {/* 新增錯誤顯示與展開按鈕 */}
                                {workspaceError && (
                                    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-red-600 text-xs font-mono whitespace-pre-wrap">
                                        <div className="flex items-start justify-between">
                                            <strong>⚠️ {workspaceError}</strong>
                                        </div>
                                        {workspaceErrorDetail && (
                                            <details className="mt-1 border-t border-red-100 pt-1">
                                                <summary className="cursor-pointer hover:text-red-800 font-semibold">顯示完整錯誤 Log</summary>
                                                <div className="mt-1 p-2 bg-white border border-gray-200 rounded max-h-40 overflow-y-auto text-gray-700 text-xs break-all">
                                                    {workspaceErrorDetail}
                                                </div>
                                            </details>
                                        )}
                                    </div>
                                )}
                                <p className="text-xs text-slate-400 mt-1">來源: {API_BASE_URL.replace('/api', '')}/builds/</p>
                            </div>

                            <div className="bg-white border rounded p-3 space-y-2">
                                <span className="text-xs font-semibold text-slate-500">選擇執行階段</span>
                                <label className="flex items-center space-x-2 text-sm cursor-pointer">
                                    <input type="checkbox" checked={runCloneStage} onChange={e => setRunCloneStage(e.target.checked)} className="rounded text-indigo-600"/>
                                    <span>Clone Stage (重新抓取程式碼)</span>
                                </label>
                                <label className="flex items-center space-x-2 text-sm cursor-pointer">
                                    <input type="checkbox" checked={runBuildStage} onChange={e => setRunBuildStage(e.target.checked)} className="rounded text-indigo-600"/>
                                    <span>Build Stage (執行編譯指令)</span>
                                </label>
                            </div>
                        </div>
                    )}

                    {/* 共用：Email 與 啟動按鈕 */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="block text-xs font-medium text-slate-700 mb-1">通知 Email</label>
                        <div className="relative mb-3">
                            <Mail className="absolute left-3 top-2.5 w-4 h-4 text-slate-400"/>
                            <input className="w-full pl-10 border rounded p-2 text-sm" placeholder="CC Emails" value={notificationEmails} onChange={e => setNotificationEmails(e.target.value)} />
                        </div>

                        <button 
                            onClick={handleStartBuild} 
                            disabled={!selectedProject.id || (activeTab === 'existing' && !selectedWorkspace)} 
                            className={`w-full text-white py-2 rounded transition-colors flex justify-center items-center font-medium
                                ${!selectedProject.id || (activeTab === 'existing' && !selectedWorkspace) 
                                    ? 'bg-slate-400 cursor-not-allowed' 
                                    : activeTab === 'new' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-yellow-600 hover:bg-yellow-700'}`}
                        >
                            <Play className="w-4 h-4 mr-2" /> 
                            {activeTab === 'new' ? '開始完整 Build' : '執行所選階段'}
                        </button>
                    </div>
                </div>
            </div>

            {/* 系統維護 */}
            <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
                <h3 className="font-semibold text-slate-700 text-sm">系統維護</h3>
                <DiskUsageBar stats={diskStats} />
                <div className="flex gap-2 pt-2">
                    <button onClick={() => handleCleanup('old')} className="flex-1 bg-orange-100 text-orange-700 text-xs py-2 rounded hover:bg-orange-200 transition-colors">刪除 &gt;7 天專案</button>
                    <button onClick={() => handleCleanup('all')} className="flex-1 bg-red-100 text-red-700 text-xs py-2 rounded hover:bg-red-200 transition-colors">刪除全部專案</button>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border h-[300px] flex flex-col">
                <div className="p-4 border-b bg-slate-50 flex justify-between items-center">
                    <h2 className="font-semibold">任務隊列 ({buildQueue.length})</h2>
                    <button onClick={handleClearHistory} title="僅清除列表顯示"><Trash2 className="w-4 h-4 text-slate-400 hover:text-red-500"/></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {buildQueue.map(job => (
                        <div key={job.id} onClick={() => setActiveJobId(job.id)} className={`p-3 rounded border text-sm cursor-pointer hover:bg-slate-50 ${viewingJob?.id === job.id ? 'border-indigo-500 bg-indigo-50' : ''}`}>
                            <div className="flex justify-between mb-1">
                                <span className="font-mono font-bold">#{job.id}</span>
                                <div className="flex gap-2 items-center">
                                    <StatusBadge status={job.status} />
                                    {['pending', 'processing'].includes(job.status) && (
                                        <button onClick={(e) => handleCancelBuild(job.id, e)} className="text-red-500 hover:text-red-700 p-1" title="中止任務"><Square className="w-3 h-3 fill-current"/></button>
                                    )}
                                </div>
                            </div>
                            <div className="truncate font-medium">{job.projectName}</div>
                            {job.workspace && job.workspace !== '(New)' && <div className="text-xs text-yellow-600 mt-1 flex items-center"><Repeat className="w-3 h-3 mr-1"/> Resumed</div>}
                        </div>
                    ))}
                </div>
            </div>
        </div>

        {/* 右側：Log 視窗 */}
        <div className="lg:col-span-2">
            <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-700 h-[calc(100vh-100px)] flex flex-col">
                <div className="bg-slate-800 p-3 border-b border-slate-700 flex justify-between items-center text-slate-300 text-sm">
                    <div className="flex items-center gap-2"><Terminal className="w-4 h-4"/> Console Output</div>
                    <div className="flex items-center gap-2">
                        {/* 下載 Log 按鈕 */}
                        {viewingJob?.logs?.length > 0 && <button onClick={handleDownloadLogs} className="flex items-center gap-1 hover:text-white"><Download className="w-4 h-4"/> Log</button>}
                        {/* 下載 ROM 按鈕 - 僅在任務完成後顯示 */}
                        {viewingJob?.status === 'completed' && <button onClick={handleDownloadRom} className="flex items-center gap-1 text-green-400 hover:text-green-300 ml-2"><FileDown className="w-4 h-4"/> ROM</button>}
                    </div>
                </div>
                <div className="flex-1 p-4 overflow-y-auto font-mono text-sm leading-6 text-slate-300">
                    {!viewingJob ? <div className="text-center mt-20 text-slate-500">等待任務...</div> : 
                        <>
                            <div className="mb-4 pb-2 border-b border-slate-700 flex flex-col gap-2">
                                <div className="flex items-center text-xs text-slate-500 font-mono">
                                    <Folder className="w-3 h-3 mr-2 text-indigo-400" />
                                    <span className="text-slate-400">{jobWorkspacePath || 'Waiting for workspace creation...'}</span>
                                </div>
                                <div className="flex justify-between text-slate-400 items-center">
                                    <span className="font-semibold text-slate-200">Job #{viewingJob.id}: {viewingJob.projectName}</span>
                                    <div className="flex items-center gap-3">
                                        <span className="text-xs text-slate-500">{viewingJob.startTime}</span>
                                        <span className={`text-xs px-2 py-0.5 rounded ${viewingJob.status === 'completed' ? 'bg-green-900 text-green-300' : viewingJob.status === 'failed' ? 'bg-red-900 text-red-300' : viewingJob.status === 'processing' ? 'bg-blue-900 text-blue-300' : 'bg-slate-700'}`}>{viewingJob.status.toUpperCase()}</span>
                                    </div>
                                </div>
                            </div>
                            {viewingJob.logs?.map((log, i) => (
                                <div key={i} className="break-all">{log}</div>
                            ))}
                            <div ref={logEndRef} />
                        </>
                    }
                </div>
            </div>
        </div>
      </main>
    </div>
  );
}
