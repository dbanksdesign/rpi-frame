import { useState, useEffect, useCallback } from 'react'
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
  onShowNav?: () => void
}

const TRANSITION_DURATION = 5000 // 5 seconds per image
const REFRESH_INTERVAL = 5000 // Check for new images every 5 seconds

function Slideshow({ onShowNav }: SlideshowProps) {
  const [images, setImages] = useState<Image[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showControls, setShowControls] = useState(false)
  const [currentImageId, setCurrentImageId] = useState<string | null>(null)

  const fetchActiveImages = useCallback(async () => {
    try {
      const response = await fetch('/api/images/active')
      if (!response.ok) throw new Error('Failed to fetch images')
      const data: Image[] = await response.json()
      
      setImages((prevImages) => {
        // Check if image list has changed
        const prevIds = prevImages.map(img => img.id).join(',')
        const newIds = data.map(img => img.id).join(',')
        const hasChanged = prevIds !== newIds
        
        if (hasChanged && prevImages.length > 0) {
          // Image list changed - adjust current index
          setCurrentImageId((prevId) => {
            if (prevId) {
              const newIndex = data.findIndex(img => img.id === prevId)
              if (newIndex !== -1) {
                // Current image still exists
                setCurrentIndex(newIndex)
              } else {
                // Current image was removed, find best new index
                setCurrentIndex((prevIndex) => Math.min(prevIndex, Math.max(0, data.length - 1)))
                return data[Math.min(prevIndex, data.length - 1)]?.id || null
              }
            }
            return prevId
          })
        } else if (data.length > 0 && prevImages.length === 0) {
          // First load - set initial image
          setCurrentImageId(data[0].id)
          setCurrentIndex(0)
        }
        
        return data
      })
      
      setLoading(false)
      
      if (data.length === 0) {
        setError('No active images to display')
        setCurrentImageId(null)
      } else {
        setError(null)
      }
    } catch (err) {
      setError('Failed to load images')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchActiveImages()
    const interval = setInterval(fetchActiveImages, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchActiveImages])

  useEffect(() => {
    if (images.length === 0) return

    const interval = setInterval(() => {
      setCurrentIndex((prev) => {
        const nextIndex = (prev + 1) % images.length
        setCurrentImageId(images[nextIndex]?.id || null)
        return nextIndex
      })
    }, TRANSITION_DURATION)

    return () => clearInterval(interval)
  }, [images])

  // Update current image ID when index changes manually
  useEffect(() => {
    if (images.length > 0 && images[currentIndex]) {
      setCurrentImageId(images[currentIndex].id)
    }
  }, [currentIndex, images])

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
          if (onShowNav) onShowNav()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [images.length, onShowNav])

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
          {onShowNav && (
            <button
              className="slideshow-exit-btn"
              onClick={onShowNav}
              title="Exit (ESC)"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default Slideshow

