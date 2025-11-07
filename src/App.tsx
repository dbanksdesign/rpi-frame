import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Slideshow from './components/Slideshow'
import Admin from './components/Admin'
import './App.css'

function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const isSlideshow = location.pathname === '/slideshow'
  const [displayOn, setDisplayOn] = useState(true)
  const [isTogglingDisplay, setIsTogglingDisplay] = useState(false)

  // Fetch initial display status
  useEffect(() => {
    const fetchDisplayStatus = async () => {
      try {
        const response = await fetch('/api/display/status')
        const data = await response.json()
        setDisplayOn(data.isOn)
      } catch (error) {
        console.error('Failed to fetch display status:', error)
      }
    }
    fetchDisplayStatus()
  }, [])

  const toggleDisplay = async () => {
    setIsTogglingDisplay(true)
    try {
      const response = await fetch('/api/display/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ power: !displayOn }),
      })
      const data = await response.json()
      if (data.success) {
        setDisplayOn(data.isOn)
        console.log(`Display ${data.isOn ? 'ON' : 'OFF'} via ${data.method}`)
      } else {
        console.error('Failed to toggle display:', data)
        alert(`Failed to toggle display.\n\nAttempted methods:\n${data.attempts?.join('\n') || 'Unknown'}\n\nCheck the server logs for details.`)
      }
    } catch (error) {
      console.error('Failed to toggle display:', error)
      alert('Failed to toggle display. Make sure you\'re running on a Raspberry Pi and check the server logs.')
    } finally {
      setIsTogglingDisplay(false)
    }
  }

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
          <button
            className={`nav-btn display-toggle ${displayOn ? 'on' : 'off'}`}
            onClick={toggleDisplay}
            disabled={isTogglingDisplay}
            title={displayOn ? 'Turn display off' : 'Turn display on'}
          >
            {isTogglingDisplay ? '...' : displayOn ? '🖥️ Display On' : '🖥️ Display Off'}
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
  const [displayOn, setDisplayOn] = useState(true)

  // Poll display status periodically
  useEffect(() => {
    const checkDisplayStatus = async () => {
      try {
        const response = await fetch('/api/display/status')
        const data = await response.json()
        setDisplayOn(data.isOn)
      } catch (error) {
        console.error('Failed to check display status:', error)
      }
    }

    // Check immediately and then every 2 seconds
    checkDisplayStatus()
    const interval = setInterval(checkDisplayStatus, 2000)

    return () => clearInterval(interval)
  }, [])

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
      {!displayOn && isSlideshow && <div className="display-blanket" />}
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

