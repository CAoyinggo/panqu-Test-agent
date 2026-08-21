import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearSession, getStoredUser } from './api';
import { useEffect, useState } from 'react';
import Login from './pages/Login';
import ReadOnlyRunReport from './pages/ReadOnlyRunReport';
import Dashboard from './pages/Dashboard';
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';
import Projects from './pages/Projects';
import Approvals from './pages/Approvals';
import Metrics from './pages/Metrics';
import Telemetry from './pages/Telemetry';
import TelemetryEvents from './pages/TelemetryEvents';
import TelemetryActivation from './pages/TelemetryActivation';
import Health from './pages/Health';
import Audit from './pages/Audit';
import Jobs from './pages/Jobs';
import Workers from './pages/Workers';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import QAHome from './pages/QAHome';
import TestSuites from './pages/TestSuites';
import TestPlans from './pages/TestPlans';
import RunTemplates from './pages/RunTemplates';
import Defects from './pages/Defects';
import RunCreate from './pages/RunCreate';
import TestAssets from './pages/TestAssets';
import AssetVersions from './pages/AssetVersions';
import AIQuality from './pages/AIQuality';
import AIImprovement from './pages/AIImprovement';
import Scale from './pages/Scale';
import CostOverview from './pages/CostOverview';

const NAV = [
  { to: '/', label: 'QA 工作台' },
  { to: '/runs', label: '执行' },
  { to: '/runs/new', label: '新建 Run' },
  { to: '/assets', label: '测试资产' },
  { to: '/suites', label: 'Suites' },
  { to: '/plans', label: 'Test Plan' },
  { to: '/templates', label: 'Template' },
  { to: '/defects', label: '缺陷' },
  { to: '/projects', label: '项目' },
  { to: '/approvals', label: '审批' },
  { to: '/metrics', label: '指标' },
  { to: '/ai-quality', label: 'AI 质量' },
  { to: '/ai-improvement', label: 'AI 改进' },
  { to: '/scale', label: 'Scale' },
  { to: '/cost', label: 'Cost' },
  { to: '/telemetry', label: '遥测' },
  { to: '/telemetry/events', label: '事件' },
  { to: '/telemetry/activation', label: '激活' },
  { to: '/jobs', label: '调度' },
  { to: '/workers', label: 'Worker' },
  { to: '/audit', label: '审计' },
  { to: '/health', label: '健康' },
  { to: '/settings', label: '设置' },
];

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const navigate = useNavigate();
  const location = useLocation();

  // 41.2：Token 失效（401）→ 自动退出回登录页（API 层 clearSession 派发事件）
  useEffect(() => {
    const onUnauthorized = (): void => {
      clearSession();
      setUser(null);
      navigate('/');
    };
    window.addEventListener('panqu:unauthorized', onUnauthorized);
    return () => window.removeEventListener('panqu:unauthorized', onUnauthorized);
  }, [navigate]);

  if (!user) {
    // Phase 40.3：无 Token 时区分公开分享落地页（/runs/:id/report?share=<token>）与登录页
    // 41.9：必须用 <Route path="/runs/:id/report"> 包裹，useParams 才能取到 :id；
    //       此前直接渲染 <ReadOnlyRunReport/> 导致 id 为空 → /runs//report → 401 → 误跳登录。
    const isPublicShare = /^\/runs\/[^/]+\/report$/.test(location.pathname) && new URLSearchParams(location.search).has('share');
    if (isPublicShare) {
      return (
        <Routes>
          <Route path="/runs/:id/report" element={<ReadOnlyRunReport />} />
        </Routes>
      );
    }
    return <Routes><Route path="*" element={<Login onLogin={setUser} />} /></Routes>;
  }

  const doLogout = (): void => {
    clearSession();
    setUser(null);
    navigate('/');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">PANQU</div>
        <div className="brand-sub">AI 测试平台控制台</div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="user-name">{user.username}</div>
          <div className="user-role">{user.role}</div>
          <button className="btn btn-ghost" onClick={doLogout}>退出</button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<QAHome />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/new" element={<RunCreate />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/assets" element={<TestAssets />} />
          <Route path="/assets/:id" element={<AssetVersions />} />
          <Route path="/suites" element={<TestSuites />} />
          <Route path="/plans" element={<TestPlans />} />
          <Route path="/templates" element={<RunTemplates />} />
          <Route path="/defects" element={<Defects />} />
          <Route path="/defects/:id" element={<Defects />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/ai-quality" element={<AIQuality />} />
          <Route path="/ai-improvement" element={<AIImprovement />} />
          <Route path="/scale" element={<Scale />} />
          <Route path="/cost" element={<CostOverview />} />
          <Route path="/telemetry" element={<Telemetry />} />
          <Route path="/telemetry/events" element={<TelemetryEvents />} />
          <Route path="/telemetry/activation" element={<TelemetryActivation />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/health" element={<Health />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
