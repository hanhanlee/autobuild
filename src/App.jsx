import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Clock, CheckCircle, XCircle, Terminal, Loader2, RefreshCw, Trash2, Server, 
  Plus, X, Save, Pencil, Download, Mail, ChevronRight, ChevronLeft, AlertTriangle, Square, 
  Folder, HardDrive, GitBranch, Hammer, Repeat, RefreshCcw, Copy, FileDown, Code,
  LayoutDashboard, Settings, Menu
} from 'lucide-react';

// --- 全域設定 ---
const FRONTEND_VERSION = 'v2.1 (Collapsible Sidebar)';
const API_BASE_URL = `http://${window.location.hostname}:3001/api`;
const IDE_BASE_URL = `http://${window.location.hostname}:8080`;

// --- 共用組件 (保持不變) ---

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
      {icons[status]}
      {status}
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
                <div 
                    className={`h-2 rounded-full ${color} transition-all duration-500`} 
                    style={{ width: stats.percent }}
                ></div>
            </div>
        </div>
    );
};

// ==========================================
// 1. 子系統：Build Verification (原有的功能)
// ==========================================
const BuildVerificationModule = () => {
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

  // Helper logic
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || {};
  const viewingJob = buildQueue.find(job => job.id === activeJobId) || buildQueue[0];
  const isWorkerRunning = buildQueue.some(job => job.status === 'processing');
  const jobWorkspacePath = viewingJob?.logs?.find(l => l && l.includes('Workspace created:'))?.split('created: ')[1]?.trim() 
                        || viewingJob?.logs?.find(l => l && l.includes('EXISTING workspace:'))?.split('workspace: ')[1]?.trim();
  const filteredWorkspaces = workspaces; 
  const currentWorkspaceObj = workspaces.find(w => w.name === selectedWorkspace);

  // API Functions
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
      setWorkspaceError(null);
      try {
          const res = await fetch(`${API_BASE_URL}/workspaces`);
          if (res.ok) {
              const data = await res.json();
              setWorkspaces(data);
          } else {
            setWorkspaceError(`HTTP ${res.status}`);
          }
      } catch (e) { setWorkspaceError(e.message); }
  };

  const fetchSystemStatus = async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/system/status`);
          if (res.ok) setDiskStats((await res.json()).disk);
      } catch(e) { console.warn("Fetch disk status failed"); }
  };

  // Initialization & Polling
  useEffect(() => {
    const initData = async () => {
        try {
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
            console.warn("Demo Mode:", e);
            setServerError(`無法連接後端 (${API_BASE_URL})`);
            setProjects(MOCK_PROJECTS);
            setSelectedProjectId(MOCK_PROJECTS[0].id);
            setDiskStats({ total: 500 * 1024 * 1024 * 1024, used: 120 * 1024 * 1024 * 1024, percent: "24%" });
        }
    };
    initData();
  }, []);

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
        } catch (e) {}
      }
    }, 2000);
    return () => clearInterval(intervalId);
  }, [buildQueue, serverError]);

  useEffect(() => {
    if (viewingJob && viewingJob.status === 'processing') {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [buildQueue, viewingJob]);

  // Actions
  const handleStartBuild = async () => {
    if (!selectedProject || !selectedProject.id) return;
    const emailList = notificationEmails.split(',').map(e => e.trim()).filter(e => e);
    if (serverError) {
        const mockJobId = `job_${Date.now()}`;
        setBuildQueue(prev => [{ id: mockJobId, projectId: selectedProject.id, projectName: selectedProject.name, status: 'pending', startTime: new Date().toLocaleString(), logs: ['[Demo] Queueing...'], notificationEmails: emailList }, ...prev]);
        setActiveJobId(mockJobId);
        return;
    }
    let payload = {
        projectId: selectedProject.id, projectName: selectedProject.name, notificationEmails: emailList,
        cloneCommands: [], buildCommands: [], existingWorkspace: null
    };
    if (activeTab === 'new') {
        if (runCloneStage) payload.cloneCommands = selectedProject.cloneCommands;
        if (runBuildStage) payload.buildCommands = selectedProject.buildCommands;
    } else {
        if (!selectedWorkspace) { alert("請選擇 Workspace"); return; }
        payload.existingWorkspace = selectedWorkspace;
        if (runCloneStage) payload.cloneCommands = selectedProject.cloneCommands;
        if (runBuildStage) payload.buildCommands = selectedProject.buildCommands;
    }
    try {
        const res = await fetch(`${API_BASE_URL}/build`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
        if (res.ok) {
            const data = await res.json();
            setBuildQueue(prev => [{ id: data.jobId, projectId: selectedProject.id, projectName: selectedProject.name, status: 'pending', startTime: new Date().toLocaleString(), logs: ['[System] Queueing...'], notificationEmails: emailList }, ...prev]);
            setActiveJobId(data.jobId);
            if (activeTab === 'new') setTimeout(fetchWorkspaces, 2000);
        } else alert("啟動失敗");
    } catch(e) { alert("連線錯誤"); }
  };

  const handleCancelBuild = async (jobId, e) => {
      e.stopPropagation();
      if (!window.confirm("確定中止？")) return;
      try { await fetch(`${API_BASE_URL}/job/${jobId}/cancel`, {method: 'POST'}); } catch(e) { alert("錯誤"); }
  };
  const handleCleanup = async (type) => {
      if(!window.confirm("確定清理？")) return;
      try { await fetch(`${API_BASE_URL}/cleanup`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type})}); fetchJobs(); fetchSystemStatus(); } catch(e) {}
  };
  const handleSaveProject = async (e) => {
      e.preventDefault();
      if(!newProjectForm.name) return;
      const pData = { id: isEditing ? selectedProjectId : `proj_${Date.now()}`, name: newProjectForm.name, description: newProjectForm.description, cloneCommands: newProjectForm.cloneCommands.split('\n').filter(l=>l.trim()), buildCommands: newProjectForm.buildCommands.split('\n').filter(l=>l.trim()) };
      if (serverError) { setIsModalOpen(false); return; }
      try {
          const res = await fetch(`${API_BASE_URL}/projects`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pData)});
          if(res.ok) { await fetchProjects(); if(!isEditing) setSelectedProjectId(pData.id); setIsModalOpen(false); setNewProjectForm({name:'',description:'',cloneCommands:'',buildCommands:''}); }
      } catch(e) { alert("儲存失敗"); }
  };
  const handleDeleteProject = async () => {
      if(!selectedProjectId || !window.confirm("刪除？")) return;
      try { const res = await fetch(`${API_BASE_URL}/projects/${selectedProjectId}`, {method:'DELETE'}); if(res.ok) { await fetchProjects(); setSelectedProjectId(''); } } catch(e){}
  };

  // View Logic Helpers
  const copyPath = () => { if(currentWorkspaceObj?.path) navigator.clipboard.writeText(currentWorkspaceObj.path); };
  const openIDE = () => { if(currentWorkspaceObj?.path) window.open(`vscode://vscode-remote/ssh-remote+scmbmc@${window.location.hostname}${currentWorkspaceObj.path}`, '_self'); };
  const dlLog = () => { if(viewingJob?.logs) { const blob=new Blob([viewingJob.logs.join('\n')],{type:'text/plain'}); const url=URL.createObjectURL(blob); const l=document.createElement('a'); l.href=url; l.download=`log_${viewingJob.id}.txt`; l.click(); }};
  const handleClearHistory = () => setBuildQueue([]); 

  // --- Render Build Module ---
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-full">
       {/* Modals & Error Bars */}
       {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
           <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-6 flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center mb-4 border-b pb-2">
                <h3 className="font-bold text-lg">{isEditing?'編輯':'新增'}專案</h3>
                <button onClick={()=>setIsModalOpen(false)}><X className="w-5 h-5 text-slate-400"/></button>
              </div>
              <form onSubmit={handleSaveProject} className="space-y-4 overflow-y-auto pr-2">
                 <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-500">專案名稱</label>
                        <input className="w-full border p-2 rounded" placeholder="名稱" value={newProjectForm.name} onChange={e=>setNewProjectForm({...newProjectForm, name:e.target.value})} required/>
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-semibold text-slate-500">描述</label>
                        <input className="w-full border p-2 rounded" placeholder="描述" value={newProjectForm.description} onChange={e=>setNewProjectForm({...newProjectForm, description:e.target.value})}/>
                    </div>
                 </div>
                 <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-500 flex items-center"><GitBranch className="w-3 h-3 mr-1"/> Clone 指令</label>
                    <textarea className="w-full h-24 border p-2 rounded font-mono text-sm bg-slate-900 text-cyan-400" placeholder="Clone Commands" value={newProjectForm.cloneCommands} onChange={e=>setNewProjectForm({...newProjectForm, cloneCommands:e.target.value})}/>
                 </div>
                 <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-500 flex items-center"><Hammer className="w-3 h-3 mr-1"/> Build 指令</label>
                    <textarea className="w-full h-32 border p-2 rounded font-mono text-sm bg-slate-900 text-green-400" placeholder="Build Commands" value={newProjectForm.buildCommands} onChange={e=>setNewProjectForm({...newProjectForm, buildCommands:e.target.value})}/>
                 </div>
                 <div className="flex gap-2 justify-end pt-2"><button type="button" onClick={()=>setIsModalOpen(false)} className="px-4 py-2 border rounded">取消</button><button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded">儲存</button></div>
              </form>
           </div>
        </div>
       )}
       
       {/* Left Panel */}
       <div className="lg:col-span-1 space-y-6 overflow-y-auto pr-2">
           {/* Status & Disk */}
           <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
                <div className="flex justify-between items-center">
                    <h3 className="font-semibold text-slate-700 text-sm">系統狀態</h3>
                    <span className={`text-xs px-2 py-1 rounded ${serverError ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{serverError ? 'Disconnected' : 'Connected'}</span>
                </div>
                <DiskUsageBar stats={diskStats} />
                <div className="flex gap-2 pt-1">
                   <button onClick={() => handleCleanup('old')} className="flex-1 bg-orange-50 text-orange-600 text-xs py-1 rounded hover:bg-orange-100">清舊檔</button>
                   <button onClick={() => handleCleanup('all')} className="flex-1 bg-red-50 text-red-600 text-xs py-1 rounded hover:bg-red-100">清全部</button>
                </div>
           </div>

           {/* Control Panel */}
           <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
               <div className="flex border-b">
                   <button onClick={()=>{setActiveTab('new');setRunCloneStage(true);setRunBuildStage(true)}} className={`flex-1 py-3 text-sm font-medium ${activeTab==='new'?'text-indigo-600 border-b-2 border-indigo-600':'text-slate-500'}`}>新 Build</button>
                   <button onClick={()=>{setActiveTab('existing');fetchWorkspaces();setRunCloneStage(false);setRunBuildStage(true)}} className={`flex-1 py-3 text-sm font-medium ${activeTab==='existing'?'text-indigo-600 border-b-2 border-indigo-600':'text-slate-500'}`}>現有 Code</button>
               </div>
               <div className="p-5 space-y-4">
                   <div className="flex gap-2">
                       <select value={selectedProjectId} onChange={e=>setSelectedProjectId(e.target.value)} className="flex-1 border rounded p-2 text-sm">{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
                       <button onClick={()=>{setIsEditing(true);setNewProjectForm({name:selectedProject.name,description:selectedProject.description,cloneCommands:(selectedProject.cloneCommands||[]).join('\n'),buildCommands:(selectedProject.buildCommands||[]).join('\n')});setIsModalOpen(true)}} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-50"><Pencil className="w-4 h-4"/></button>
                       <button onClick={()=>{setIsEditing(false);setNewProjectForm({name:'',description:'',cloneCommands:'',buildCommands:''});setIsModalOpen(true)}} className="p-2 border rounded hover:bg-slate-50 text-indigo-600"><Plus className="w-4 h-4"/></button>
                       <button onClick={handleDeleteProject} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-50 text-red-600"><Trash2 className="w-4 h-4"/></button>
                   </div>
                   
                   {activeTab === 'existing' && (
                       <div className="space-y-2">
                           <div className="flex justify-between"><label className="text-xs font-medium">Workspace</label><button onClick={fetchWorkspaces}><RefreshCcw className="w-3 h-3"/></button></div>
                           <select value={selectedWorkspace} onChange={e=>setSelectedWorkspace(e.target.value)} className="w-full border rounded p-2 text-sm bg-yellow-50">{filteredWorkspaces.map(w=><option key={w.name} value={w.name}>{w.name}</option>)}</select>
                           {currentWorkspaceObj && (
                               <div className="flex gap-1">
                                   <button onClick={copyPath} className="flex-1 bg-slate-100 text-xs py-1 rounded flex items-center justify-center gap-1 hover:bg-slate-200"><Copy className="w-3 h-3"/> 複製路徑</button>
                                   <button onClick={openIDE} className="flex-1 bg-blue-600 text-white text-xs py-1 rounded flex items-center justify-center gap-1 hover:bg-blue-700"><Code className="w-3 h-3"/> VS Code</button>
                               </div>
                           )}
                       </div>
                   )}

                   <div className="bg-slate-50 p-3 rounded space-y-2 border">
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={runCloneStage} onChange={e=>setRunCloneStage(e.target.checked)}/> Clone Stage</label>
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={runBuildStage} onChange={e=>setRunBuildStage(e.target.checked)}/> Build Stage</label>
                   </div>
                   <input className="w-full border rounded p-2 text-sm" placeholder="通知 Email (選填)" value={notificationEmails} onChange={e=>setNotificationEmails(e.target.value)}/>
                   <button onClick={handleStartBuild} disabled={!selectedProject.id} className="w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700 disabled:bg-slate-300">執行任務</button>
               </div>
           </div>

           <div className="bg-white rounded-xl shadow-sm border h-[300px] flex flex-col">
               <div className="p-3 border-b bg-slate-50 flex justify-between items-center"><span className="font-semibold text-sm">任務紀錄</span><button onClick={handleClearHistory}><Trash2 className="w-4 h-4 text-slate-400 hover:text-red-500"/></button></div>
               <div className="flex-1 overflow-y-auto p-2 space-y-2">
                   {buildQueue.map(job => (
                       <div key={job.id} onClick={()=>setActiveJobId(job.id)} className={`p-2 rounded border text-xs cursor-pointer ${viewingJob?.id===job.id?'border-indigo-500 bg-indigo-50':'hover:bg-slate-50'}`}>
                           <div className="flex justify-between mb-1"><span className="font-bold">#{job.id}</span><StatusBadge status={job.status}/></div>
                           <div className="truncate">{job.projectName}</div>
                           {['pending','processing'].includes(job.status) && <button onClick={(e)=>handleCancelBuild(job.id, e)} className="mt-1 w-full text-center bg-red-100 text-red-600 py-1 rounded hover:bg-red-200">中止</button>}
                       </div>
                   ))}
               </div>
           </div>
       </div>

       {/* Right Panel (Log) */}
       <div className="lg:col-span-2 bg-slate-900 rounded-xl shadow-lg border border-slate-700 flex flex-col h-[calc(100vh-4rem)]">
           <div className="bg-slate-800 p-3 border-b border-slate-700 flex justify-between items-center text-slate-300 text-sm">
               <div className="flex items-center gap-2"><Terminal className="w-4 h-4"/> Console: {viewingJob?.id ? `#${viewingJob.id}` : 'Waiting...'}</div>
               <div className="flex gap-2">
                   {viewingJob?.logs?.length > 0 && <button onClick={dlLog} className="flex items-center gap-1 hover:text-white"><Download className="w-4 h-4"/> Log</button>}
                   {viewingJob?.status === 'completed' && <button onClick={()=>window.location.href=`${API_BASE_URL}/job/${viewingJob.id}/download/rom`} className="flex items-center gap-1 text-green-400 hover:text-white"><FileDown className="w-4 h-4"/> ROM</button>}
               </div>
           </div>
           <div className="flex-1 p-4 overflow-y-auto font-mono text-sm leading-6 text-slate-300">
               {!viewingJob ? <div className="text-center mt-20 text-slate-500">請選擇或啟動一個任務</div> : 
                 <>
                    <div className="mb-4 pb-2 border-b border-slate-700 text-xs text-slate-500 font-mono">
                        <Folder className="inline w-3 h-3 mr-1"/> {jobWorkspacePath || 'Workspace path pending...'}
                    </div>
                    {viewingJob.logs?.map((l,i)=><div key={i} className="break-all">{l}</div>)}
                    <div ref={logEndRef}/>
                 </>
               }
           </div>
       </div>
    </div>
  );
};

// ==========================================
// 3. 主框架：App Shell (Sidebar + Routing)
// ==========================================
const StatusBadgeComponent = ({ status }) => { /* Reused inside BuildModule */ return null; } // Dummy to avoid lint errors if moved

export default function App() {
  const [currentView, setCurrentView] = useState('build'); // 'build' | 'cve' | 'query' | 'settings'
  const [isSidebarOpen, setIsSidebarOpen] = useState(true); // Sidebar collapse state

  const MENU_ITEMS = [
    { id: 'build', label: 'Build 驗證', icon: LayoutDashboard },
    // { id: 'query', label: '系統查詢', icon: Search },
    // { id: 'cve',   label: 'CVE 分析',   icon: ShieldAlert },
  ];

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className={`bg-slate-900 text-slate-300 flex flex-col shrink-0 transition-all duration-300 ${isSidebarOpen ? 'w-64' : 'w-20'}`}>
        {/* Sidebar Header */}
        <div className={`h-16 flex items-center ${isSidebarOpen ? 'px-6 justify-between' : 'justify-center'} border-b border-slate-800`}>
          {isSidebarOpen ? (
            <>
              <div className="flex items-center">
                <div className="bg-indigo-600 p-1.5 rounded mr-3">
                  <Server className="w-5 h-5 text-white" />
                </div>
                <span className="font-bold text-white tracking-wide">DevOps</span>
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="text-slate-400 hover:text-white">
                <ChevronLeft className="w-5 h-5" />
              </button>
            </>
          ) : (
            <button onClick={() => setIsSidebarOpen(true)} className="text-slate-400 hover:text-white">
              <Menu className="w-6 h-6" />
            </button>
          )}
        </div>

        <nav className="flex-1 py-6 px-3 space-y-1">
          {MENU_ITEMS.map(item => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id)}
                className={`w-full flex items-center py-2.5 rounded-lg transition-colors ${
                  isActive 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/50' 
                    : 'hover:bg-slate-800 hover:text-white'
                } ${isSidebarOpen ? 'px-3' : 'justify-center px-2'}`}
                title={!isSidebarOpen ? item.label : ''}
              >
                <Icon className={`w-5 h-5 ${isSidebarOpen ? 'mr-3' : ''} ${isActive ? 'text-white' : 'text-slate-400'}`} />
                {isSidebarOpen && <span className="font-medium">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <button className={`w-full flex items-center py-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors ${isSidebarOpen ? 'px-3' : 'justify-center px-2'}`}>
            <Settings className={`w-5 h-5 ${isSidebarOpen ? 'mr-3' : ''}`} />
            {isSidebarOpen && <span>系統設定</span>}
          </button>
          {isSidebarOpen && <div className="mt-4 text-xs text-slate-600 text-center">{FRONTEND_VERSION}</div>}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-100">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shrink-0">
            <h2 className="text-xl font-bold text-slate-800">
                {MENU_ITEMS.find(i => i.id === currentView)?.label}
            </h2>
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold text-xs border border-indigo-200">
                    OP
                </div>
            </div>
        </header>

        {/* Content View */}
        <div className="flex-1 overflow-hidden p-6 relative">
            <div className="absolute inset-0 p-6 overflow-auto">
                {currentView === 'build' && <BuildVerificationModule />}
            </div>
        </div>
      </main>
    </div>
  );
}
