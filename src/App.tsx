import { useState } from 'react'
import Slideshow from './components/Slideshow'
import Admin from './components/Admin'
import './App.css'

function App() {
  const [view, setView] = useState<'slideshow' | 'admin'>('admin')
  const [showNav, setShowNav] = useState(true)

  const handleViewChange = (newView: 'slideshow' | 'admin') => {
    setView(newView)
    setShowNav(newView === 'admin')
  }

  return (
    <div className="app">
      <nav className={`nav-bar ${!showNav ? 'hidden' : ''}`}>
        <div className="nav-content">
          <h1 className="nav-title">📸 Digital Photo Frame</h1>
          <div className="nav-buttons">
            <button
              className={`nav-btn ${view === 'slideshow' ? 'active' : ''}`}
              onClick={() => handleViewChange('slideshow')}
            >
              Slideshow
            </button>
            <button
              className={`nav-btn ${view === 'admin' ? 'active' : ''}`}
              onClick={() => handleViewChange('admin')}
            >
              Manage Photos
            </button>
          </div>
        </div>
      </nav>

      <main className={`main-content ${!showNav ? 'fullscreen' : ''}`}>
        {view === 'slideshow' ? (
          <Slideshow onShowNav={() => setShowNav(true)} />
        ) : (
          <Admin />
        )}
      </main>
    </div>
  )
}

export default App

