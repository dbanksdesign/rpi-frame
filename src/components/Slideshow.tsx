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

interface SlideshowState {
  currentImageId: string | null
  duration: number
  activeCollectionId: string | null
}

const REFRESH_INTERVAL = 5000 // Check for new images every 5 seconds
const STATE_POLL_INTERVAL = 1000 // Check for state changes every second

function Slideshow({ onShowNav }: SlideshowProps) {
  const [images, setImages] = useState<Image[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showControls, setShowControls] = useState(false)
  const [currentImageId, setCurrentImageId] = useState<string | null>(null)
  const [duration, setDuration] = useState(120000) // 2 minutes default
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null)

  // Fetch slideshow state (current image, duration, and active collection)
  const fetchSlideshowState = useCallback(async () => {
    try {
      const response = await fetch('/api/slideshow/state')
      if (!response.ok) throw new Error('Failed to fetch slideshow state')
      const data: SlideshowState = await response.json()
      
      setDuration(data.duration)
      
      // Update active collection if changed
      if (data.activeCollectionId !== activeCollectionId) {
        setActiveCollectionId(data.activeCollectionId)
      }
      
      // If the server has a different current image, jump to it
      if (data.currentImageId && data.currentImageId !== currentImageId) {
        const newIndex = images.findIndex(img => img.id === data.currentImageId)
        if (newIndex !== -1) {
          setCurrentIndex(newIndex)
          setCurrentImageId(data.currentImageId)
        }
      }
    } catch (err) {
      console.error('Failed to fetch slideshow state:', err)
    }
  }, [images, currentImageId, activeCollectionId])

  // Update server with current image
  const updateCurrentImage = useCallback(async (imageId: string | null) => {
    try {
      await fetch('/api/slideshow/current', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ imageId }),
      })
    } catch (err) {
      console.error('Failed to update current image:', err)
    }
  }, [])

  const fetchActiveImages = useCallback(async () => {
    try {
      // Fetch images filtered by active collection if one is set
      const url = activeCollectionId 
        ? `/api/images/active?collectionId=${activeCollectionId}`
        : '/api/images/active'
      const response = await fetch(url)
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
                const safeIndex = Math.min(currentIndex, Math.max(0, data.length - 1))
                setCurrentIndex(safeIndex)
                return data[safeIndex]?.id || null
              }
            }
            return prevId
          })
        } else if (data.length > 0 && prevImages.length === 0) {
          // First load - set initial image
          const initialImageId = data[0].id
          setCurrentImageId(initialImageId)
          setCurrentIndex(0)
          updateCurrentImage(initialImageId)
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
  }, [updateCurrentImage, activeCollectionId])

  useEffect(() => {
    fetchActiveImages()
    const interval = setInterval(fetchActiveImages, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchActiveImages])

  // Poll for state changes (current image selection from admin panel)
  useEffect(() => {
    const interval = setInterval(fetchSlideshowState, STATE_POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchSlideshowState])

  useEffect(() => {
    if (images.length === 0) return

    // For single image, no need to cycle but still update the image
    if (images.length === 1) {
      const singleImageId = images[0]?.id || null
      if (currentImageId !== singleImageId) {
        setCurrentImageId(singleImageId)
        updateCurrentImage(singleImageId)
      }
      return
    }

    const interval = setInterval(() => {
      setCurrentIndex((prev) => {
        const nextIndex = (prev + 1) % images.length
        const nextImageId = images[nextIndex]?.id || null
        setCurrentImageId(nextImageId)
        updateCurrentImage(nextImageId)
        return nextIndex
      })
    }, duration)

    return () => clearInterval(interval)
  }, [images, duration, updateCurrentImage, currentImageId])

  // Update current image ID when index changes manually
  useEffect(() => {
    if (images.length > 0) {
      // Ensure currentIndex is within bounds
      const safeIndex = Math.min(currentIndex, images.length - 1)
      if (safeIndex !== currentIndex) {
        setCurrentIndex(safeIndex)
      }
      
      const image = images[safeIndex]
      if (image) {
        const newImageId = image.id
        if (newImageId !== currentImageId) {
          setCurrentImageId(newImageId)
          updateCurrentImage(newImageId)
        }
      }
    }
  }, [currentIndex, images, updateCurrentImage, currentImageId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (images.length === 0) return
      
      switch(e.key) {
        case 'ArrowLeft':
          if (images.length > 1) {
            setCurrentIndex((prev) => (prev - 1 + images.length) % images.length)
          }
          break
        case 'ArrowRight':
          if (images.length > 1) {
            setCurrentIndex((prev) => (prev + 1) % images.length)
          }
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
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          className={`slideshow-image ${index === currentIndex ? 'active' : ''}`}
        >
          <img src={image.path} alt={image.originalName} />
        </div>
      ))}
    </div>
  )
}

export default Slideshow

