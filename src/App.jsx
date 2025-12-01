import React, { useState, useEffect, useRef } from 'react';
import { Play, Clock, CheckCircle, XCircle, Terminal, Loader2, RefreshCw, Trash2, Server, Plus, X, Save, Pencil, Download, Mail, ChevronRight, AlertTriangle, Square, Folder, HardDrive } from 'lucide-react';

const API_BASE_URL = 'http://localhost:3001/api';

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
      {icons[status]}
      {status}
    </span>
  );
};

// --- 硬碟空間顯示組件 ---
const DiskUsageBar = ({ stats }) => {
    if (!stats) return null;
    
    // 轉換為 GB
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

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [buildQueue, setBuildQueue] = useState([]);
  const [notificationEmails, setNotificationEmails] = useState('');
  const [serverError, setServerError] = useState(null);
  const [diskStats, setDiskStats] = useState(null);
  
  const [activeJobId, setActiveJobId] = useState(null);
  const logEndRef = useRef(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newProjectForm, setNewProjectForm] = useState({ name: '', description: '', commands: '' });

  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || {};
  const viewingJob = buildQueue.find(job => job.id === activeJobId) || buildQueue[0];
  const isWorkerRunning = buildQueue.some(job => job.status === 'processing');
  const jobWorkspacePath = viewingJob?.logs?.find(l => l && l.includes('Workspace created:'))?.split('created: ')[1]?.trim();

  // --- 初始化 ---
  useEffect(() => {
    const initData = async () => {
        await fetchProjects();
        await fetchJobs();
        await fetchSystemStatus();
    };
    initData();
  }, []);

  const fetchProjects = async () => {
    try {
        const res = await fetch(`${API_BASE_URL}/projects`);
        if (!res.ok) throw new Error('Network error');
        const data = await res.json();
        setProjects(data);
        if (data.length > 0 && !selectedProjectId) setSelectedProjectId(data[0].id);
        setServerError(null);
    } catch (e) { setServerError("無法連接後端 (Projects)"); }
  };

  const fetchJobs = async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/jobs`);
          if (!res.ok) throw new Error('Network error');
          const data = await res.json();
          setBuildQueue(data);
      } catch (e) { setServerError("無法連接後端 (Jobs)"); }
  };

  const fetchSystemStatus = async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/system/status`);
          if (res.ok) {
              const data = await res.json();
              setDiskStats(data.disk);
          }
      } catch(e) { console.error("Disk stat failed"); }
  };

  // --- Polling ---
  useEffect(() => {
    if (serverError) return;
    const intervalId = setInterval(async () => {
      const activeJobs = buildQueue.filter(job => ['processing', 'pending'].includes(job.status));
      // 每 5 秒也更新一次硬碟資訊
      if (new Date().getSeconds() % 5 === 0) fetchSystemStatus();

      if (activeJobs.length === 0) return;

      for (const job of activeJobs) {
        try {
          const response = await fetch(`${API_BASE_URL}/job/${job.id}`);
          if (response.ok) {
            const updatedJob = await response.json();
            setBuildQueue(prev => prev.map(item => item.id === updatedJob.id ? updatedJob : item));
            setServerError(null);
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
    try {
      const response = await fetch(`${API_BASE_URL}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProject.id,
          projectName: selectedProject.name,
          commands: selectedProject.commands,
          notificationEmails: emailList
        })
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
        setServerError(null);
      } else { alert("啟動失敗"); }
    } catch (e) { alert("啟動失敗：連線錯誤"); setServerError("連線中斷"); }
  };

  const handleCancelBuild = async (jobId, e) => {
      e.stopPropagation();
      if (!window.confirm("確定要中止這個任務嗎？")) return;
      try {
          await fetch(`${API_BASE_URL}/job/${jobId}/cancel`, { method: 'POST' });
          setBuildQueue(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
      } catch (e) { alert("連線錯誤"); }
  };

  const handleCleanup = async (type) => {
      const confirmMsg = type === 'all' 
        ? "警告：這將會刪除「所有」歷史任務與 Build 檔案。確定執行？" 
        : "確定要刪除 7 天以前的舊任務與檔案嗎？";
      
      if (!window.confirm(confirmMsg)) return;

      try {
          const res = await fetch(`${API_BASE_URL}/cleanup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type })
          });
          if (res.ok) {
              const data = await res.json();
              alert(data.message);
              fetchJobs(); // 重新整理列表
              fetchSystemStatus(); // 更新硬碟空間
          }
      } catch (e) { alert("清理失敗"); }
  };

  // CRUD & Helpers
  const handleSaveProject = async (e) => {
    e.preventDefault();
    if (!newProjectForm.name) return;
    const projectData = {
        id: isEditing ? selectedProjectId : `proj_${Date.now()}`,
        name: newProjectForm.name,
        description: newProjectForm.description,
        commands: newProjectForm.commands.split('\n').filter(l => l.trim())
    };
    try {
        const res = await fetch(`${API_BASE_URL}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectData)
        });
        if (res.ok) {
            fetchProjects();
            if (!isEditing) setSelectedProjectId(projectData.id);
            setIsModalOpen(false);
            setNewProjectForm({ name: '', description: '', commands: '' });
        }
    } catch(e) { alert("儲存失敗"); }
  };

  const handleDeleteProject = async () => {
      if (!selectedProjectId || !window.confirm("確定刪除此專案？")) return;
      try {
          const res = await fetch(`${API_BASE_URL}/projects/${selectedProjectId}`, { method: 'DELETE' });
          if (res.ok) { fetchProjects(); setSelectedProjectId(''); }
      } catch(e) { alert("刪除失敗"); }
  };

  const openCreateModal = () => { setIsEditing(false); setNewProjectForm({ name: '', description: '', commands: '' }); setIsModalOpen(true); };
  const openEditModal = () => {
    if (!selectedProject.id) return;
    setIsEditing(true);
    setNewProjectForm({ name: selectedProject.name, description: selectedProject.description, commands: (selectedProject.commands || []).join('\n') });
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {serverError && <div className="bg-red-600 text-white px-4 py-2 text-sm text-center font-bold flex justify-center items-center"><AlertTriangle className="mr-2 w-4 h-4"/>{serverError} - 請確認後端 (node server.js) 已啟動</div>}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-bold text-lg text-slate-800">{isEditing ? '編輯' : '新增'}客戶專案</h3>
              <button onClick={() => setIsModalOpen(false)}><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <form onSubmit={handleSaveProject} className="p-6 space-y-4">
              <input className="w-full border p-2 rounded" placeholder="專案名稱" value={newProjectForm.name} onChange={e => setNewProjectForm({...newProjectForm, name: e.target.value})} required />
              <input className="w-full border p-2 rounded" placeholder="描述" value={newProjectForm.description} onChange={e => setNewProjectForm({...newProjectForm, description: e.target.value})} />
              <textarea className="w-full h-32 border p-2 rounded font-mono text-sm bg-slate-900 text-green-400" placeholder="ls -la" value={newProjectForm.commands} onChange={e => setNewProjectForm({...newProjectForm, commands: e.target.value})} required />
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 border p-2 rounded">取消</button>
                <button type="submit" className="flex-1 bg-indigo-600 text-white p-2 rounded">儲存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white shadow-sm border-b h-16 flex items-center px-8 justify-between">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg"><Server className="text-white w-6 h-6"/></div>
            <h1 className="text-xl font-bold">內部 Build 驗證系統</h1>
        </div>
        <div className="flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-full text-sm text-slate-500">
            <div className={`w-2 h-2 rounded-full ${isWorkerRunning ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}`}></div>
            Build Server: {serverError ? 'Disconnected' : 'Connected'}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-6">
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden p-5 space-y-4">
                <h2 className="text-lg font-semibold flex items-center"><Play className="w-5 h-5 mr-2 text-indigo-600"/>啟動 Build</h2>
                
                <div className="flex gap-2">
                    <select value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)} className="flex-1 border rounded p-2 text-sm min-w-0">
                        {projects.length > 0 ? projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>) : <option>Loading...</option>}
                    </select>
                    <button onClick={openEditModal} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-100 disabled:opacity-50"><Pencil className="w-4 h-4"/></button>
                    <button onClick={openCreateModal} className="p-2 border rounded hover:bg-slate-100 text-indigo-600"><Plus className="w-4 h-4"/></button>
                    <button onClick={handleDeleteProject} disabled={!selectedProject.id} className="p-2 border rounded hover:bg-slate-100 text-red-600 disabled:opacity-50"><Trash2 className="w-4 h-4"/></button>
                </div>
                <p className="text-xs text-slate-500">{selectedProject.description || (serverError ? '連線中斷' : '請選擇專案')}</p>

                <div className="relative">
                    <Mail className="absolute left-3 top-2.5 w-4 h-4 text-slate-400"/>
                    <input className="w-full pl-10 border rounded p-2 text-sm" placeholder="CC Emails (comma separated)" value={notificationEmails} onChange={e => setNotificationEmails(e.target.value)} />
                </div>

                <div className="bg-slate-800 rounded p-3 text-xs font-mono text-green-400 space-y-1">
                    {(selectedProject.commands || []).map((cmd, i) => <div key={i}>$ {cmd}</div>)}
                </div>

                <button onClick={handleStartBuild} disabled={!selectedProject.id || !!serverError} className="w-full bg-indigo-600 text-white py-2 rounded disabled:bg-slate-400">開始 Build</button>
            </div>

            {/* 系統維護區塊 (新增) */}
            <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
                <h3 className="font-semibold text-slate-700 text-sm">系統維護</h3>
                <DiskUsageBar stats={diskStats} />
                <div className="flex gap-2 pt-2">
                    <button onClick={() => handleCleanup('old')} className="flex-1 bg-orange-100 text-orange-700 text-xs py-2 rounded hover:bg-orange-200 transition-colors">
                        刪除 &gt;7 天專案
                    </button>
                    <button onClick={() => handleCleanup('all')} className="flex-1 bg-red-100 text-red-700 text-xs py-2 rounded hover:bg-red-200 transition-colors">
                        刪除全部專案
                    </button>
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
                                        <button onClick={(e) => handleCancelBuild(job.id, e)} className="text-red-500 hover:text-red-700 p-1" title="中止任務">
                                            <Square className="w-3 h-3 fill-current"/>
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="truncate font-medium">{job.projectName}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>

        <div className="lg:col-span-2">
            <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-700 h-[calc(100vh-100px)] flex flex-col">
                <div className="bg-slate-800 p-3 border-b border-slate-700 flex justify-between items-center text-slate-300 text-sm">
                    <div className="flex items-center gap-2"><Terminal className="w-4 h-4"/> Console Output</div>
                    {viewingJob?.logs?.length > 0 && <button onClick={handleDownloadLogs} className="flex items-center gap-1 hover:text-white"><Download className="w-4 h-4"/> Download</button>}
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
