import { useState, useEffect, useRef } from 'react'
import { useWebSocket } from '../context/WebSocketContext'
import './Slideshow.css'

interface SlideshowProps {
  onShowNav?: () => void
}

function Slideshow({ onShowNav }: SlideshowProps) {
  const { activeImages, slideshowState, connected, setCurrentImage } = useWebSocket()
  const [currentIndex, setCurrentIndex] = useState(0)
  
  // Track the last image ID we synced from server to avoid re-sending
  const lastServerImageIdRef = useRef<string | null>(null)

  const { duration, currentImageId: serverCurrentImageId } = slideshowState

  // Sync with server's current image when it changes (e.g., from admin "Show Now")
  useEffect(() => {
    if (serverCurrentImageId && serverCurrentImageId !== lastServerImageIdRef.current) {
      lastServerImageIdRef.current = serverCurrentImageId
      const idx = activeImages.findIndex(img => img.id === serverCurrentImageId)
      if (idx !== -1 && idx !== currentIndex) {
        setCurrentIndex(idx)
      }
    }
  }, [serverCurrentImageId, activeImages, currentIndex])

  // Handle image list changes - adjust index if current image was removed
  useEffect(() => {
    if (activeImages.length === 0) {
      setCurrentIndex(0)
      return
    }

    // Check if current index is out of bounds
    if (currentIndex >= activeImages.length) {
      setCurrentIndex(activeImages.length - 1)
    }
  }, [activeImages.length, currentIndex])

  // Auto-advance slideshow
  useEffect(() => {
    if (activeImages.length <= 1) return

    const interval = setInterval(() => {
      setCurrentIndex((prev) => {
        const nextIndex = (prev + 1) % activeImages.length
        // Notify server of auto-advance
        const nextImageId = activeImages[nextIndex]?.id
        if (nextImageId) {
          setCurrentImage(nextImageId)
          lastServerImageIdRef.current = nextImageId
        }
        return nextIndex
      })
    }, duration)

    return () => clearInterval(interval)
  }, [activeImages, duration, setCurrentImage])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeImages.length === 0) return
      
      switch(e.key) {
        case 'ArrowLeft':
          if (activeImages.length > 1) {
            setCurrentIndex((prev) => {
              const nextIndex = (prev - 1 + activeImages.length) % activeImages.length
              // Notify server of manual navigation
              const nextImageId = activeImages[nextIndex]?.id
              if (nextImageId) {
                setCurrentImage(nextImageId)
                lastServerImageIdRef.current = nextImageId
              }
              return nextIndex
            })
          }
          break
        case 'ArrowRight':
          if (activeImages.length > 1) {
            setCurrentIndex((prev) => {
              const nextIndex = (prev + 1) % activeImages.length
              // Notify server of manual navigation
              const nextImageId = activeImages[nextIndex]?.id
              if (nextImageId) {
                setCurrentImage(nextImageId)
                lastServerImageIdRef.current = nextImageId
              }
              return nextIndex
            })
          }
          break
        case 'Escape':
          if (onShowNav) onShowNav()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeImages, onShowNav, setCurrentImage])

  if (!connected) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">Connecting...</div>
      </div>
    )
  }

  if (activeImages.length === 0) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">
          No active images to display
          <p className="slideshow-hint">
            Switch to "Manage Photos" to upload images
          </p>
        </div>
      </div>
    )
  }

  // Ensure index is valid
  const safeIndex = Math.min(currentIndex, activeImages.length - 1)

  return (
    <div className="slideshow-container">
      {activeImages.map((image, index) => (
        <div
          key={image.id}
          className={`slideshow-image ${index === safeIndex ? 'active' : ''}`}
        >
          <img src={image.path} alt={image.originalName} />
        </div>
      ))}
    </div>
  )
}

export default Slideshow
