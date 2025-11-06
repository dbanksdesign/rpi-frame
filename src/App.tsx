import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Slideshow from './components/Slideshow'
import Admin from './components/Admin'
import './App.css'

function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const isSlideshow = location.pathname === '/slideshow'

  if (isSlideshow) {
    return null // No navigation bar in slideshow mode
  }

  return (
    <nav className="nav-bar">
      <div className="nav-content">
        <h1 className="nav-title">📸 Digital Photo Frame</h1>
        <div className="nav-buttons">
          <button
            className={`nav-btn ${isSlideshow ? 'active' : ''}`}
            onClick={() => navigate('/slideshow')}
          >
            Slideshow
          </button>
          <button
            className={`nav-btn ${location.pathname === '/manage' ? 'active' : ''}`}
            onClick={() => navigate('/manage')}
          >
            Manage Photos
          </button>
        </div>
      </div>
    </nav>
  )
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const isSlideshow = location.pathname === '/slideshow'

  return (
    <div className="app">
      <Navigation />
      <main className={`main-content ${isSlideshow ? 'fullscreen' : ''}`}>
        <Routes>
          <Route path="/slideshow" element={<Slideshow onShowNav={() => navigate('/manage')} />} />
          <Route path="/manage" element={<Admin />} />
          <Route path="/" element={<Navigate to="/manage" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}

export default App

