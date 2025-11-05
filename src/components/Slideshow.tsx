import { useState, useEffect } from 'react'
import './Slideshow.css'

interface Image {
  id: string
  filename: string
  originalName: string
  path: string
  uploadedAt: string
  active: boolean
}

interface SlideshowProps {
  onShowNav: () => void
}

const TRANSITION_DURATION = 5000 // 5 seconds per image

function Slideshow({ onShowNav }: SlideshowProps) {
  const [images, setImages] = useState<Image[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showControls, setShowControls] = useState(false)

  useEffect(() => {
    fetchActiveImages()
    const interval = setInterval(fetchActiveImages, 30000) // Refresh every 30 seconds
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (images.length === 0) return

    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % images.length)
    }, TRANSITION_DURATION)

    return () => clearInterval(interval)
  }, [images.length])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (images.length === 0) return
      
      switch(e.key) {
        case 'ArrowLeft':
          setCurrentIndex((prev) => (prev - 1 + images.length) % images.length)
          break
        case 'ArrowRight':
          setCurrentIndex((prev) => (prev + 1) % images.length)
          break
        case 'Escape':
          onShowNav()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [images.length, onShowNav])

  const fetchActiveImages = async () => {
    try {
      const response = await fetch('/api/images/active')
      if (!response.ok) throw new Error('Failed to fetch images')
      const data = await response.json()
      setImages(data)
      setLoading(false)
      if (data.length === 0) {
        setError('No active images to display')
      } else {
        setError(null)
      }
    } catch (err) {
      setError('Failed to load images')
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">Loading...</div>
      </div>
    )
  }

  if (error || images.length === 0) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">
          {error || 'No images available'}
          <p className="slideshow-hint">
            Switch to "Manage Photos" to upload images
          </p>
        </div>
      </div>
    )
  }

  return (
    <div 
      className="slideshow-container"
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          className={`slideshow-image ${index === currentIndex ? 'active' : ''}`}
        >
          <img src={image.path} alt={image.originalName} />
        </div>
      ))}
      
      {showControls && (
        <div className="slideshow-controls">
          <button
            className="slideshow-control-btn"
            onClick={() => setCurrentIndex((prev) => (prev - 1 + images.length) % images.length)}
            title="Previous (←)"
          >
            ‹
          </button>
          <div className="slideshow-indicator">
            {currentIndex + 1} / {images.length}
          </div>
          <button
            className="slideshow-control-btn"
            onClick={() => setCurrentIndex((prev) => (prev + 1) % images.length)}
            title="Next (→)"
          >
            ›
          </button>
          <button
            className="slideshow-exit-btn"
            onClick={onShowNav}
            title="Exit (ESC)"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

export default Slideshow

