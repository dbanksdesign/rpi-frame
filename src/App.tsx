import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { AppShell, Group, Title, Button, ActionIcon, useMantineColorScheme, Box } from '@mantine/core'
import { IconSun, IconMoon, IconPhoto, IconSettings, IconDeviceDesktop, IconDeviceDesktopOff, IconFrame } from '@tabler/icons-react'
import { useMediaQuery } from '@mantine/hooks'
import { WebSocketProvider } from './context/WebSocketContext'
import Slideshow from './components/Slideshow'
import Admin from './components/Admin'
import Setup from './components/Setup'
import { useSetupState } from './setup/useSetupState'
import ErrorBoundary from './components/ErrorBoundary'
import './App.css'

function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const isSlideshow = location.pathname === '/slideshow'
  const [displayOn, setDisplayOn] = useState(true)
  const [isTogglingDisplay, setIsTogglingDisplay] = useState(false)
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const isMobile = useMediaQuery('(max-width: 768px)')

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
    <AppShell.Header p="md">
      <Group justify="space-between" h="100%" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <IconFrame size={28} stroke={2} />
          <Title order={2} size={isMobile ? 'h4' : 'h3'} style={{ whiteSpace: 'nowrap' }}>
            Frame
          </Title>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {isMobile ? (
            <>
              <ActionIcon
                variant={location.pathname === '/slideshow' ? 'filled' : 'light'}
                size="lg"
                onClick={() => navigate('/slideshow')}
                title="Slideshow"
              >
                <IconPhoto size={18} />
              </ActionIcon>
              <ActionIcon
                variant={location.pathname === '/manage' ? 'filled' : 'light'}
                size="lg"
                onClick={() => navigate('/manage')}
                title="Manage Photos"
              >
                <IconSettings size={18} />
              </ActionIcon>
              <ActionIcon
                variant="light"
                color={displayOn ? 'green' : 'red'}
                size="lg"
                onClick={toggleDisplay}
                loading={isTogglingDisplay}
                title={displayOn ? 'Turn display off' : 'Turn display on'}
              >
                {displayOn ? <IconDeviceDesktop size={18} /> : <IconDeviceDesktopOff size={18} />}
              </ActionIcon>
              <ActionIcon
                variant="light"
                size="lg"
                onClick={() => toggleColorScheme()}
                title="Toggle color scheme"
              >
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </>
          ) : (
            <>
              <Button
                variant={location.pathname === '/slideshow' ? 'filled' : 'light'}
                leftSection={<IconPhoto size={18} />}
                onClick={() => navigate('/slideshow')}
              >
                Slideshow
              </Button>
              <Button
                variant={location.pathname === '/manage' ? 'filled' : 'light'}
                leftSection={<IconSettings size={18} />}
                onClick={() => navigate('/manage')}
              >
                Manage Photos
              </Button>
              <Button
                variant="light"
                color={displayOn ? 'green' : 'red'}
                leftSection={displayOn ? <IconDeviceDesktop size={18} /> : <IconDeviceDesktopOff size={18} />}
                onClick={toggleDisplay}
                loading={isTogglingDisplay}
                title={displayOn ? 'Turn display off' : 'Turn display on'}
              >
                Display {displayOn ? 'On' : 'Off'}
              </Button>
              <ActionIcon
                variant="light"
                size="lg"
                onClick={() => toggleColorScheme()}
                title="Toggle color scheme"
              >
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </>
          )}
        </Group>
      </Group>
    </AppShell.Header>
  )
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const isSlideshow = location.pathname === '/slideshow'
  const [displayOn, setDisplayOn] = useState(true)
  const setup = useSetupState()

  // Fetch display status once on mount
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

  if (isSlideshow) {
    if (setup.state && setup.screen !== 'slideshow') {
      return <Setup state={setup.state} screen={setup.screen} onDismiss={setup.dismissReadyCard} />
    }
    return (
      <Box pos="relative">
        <ErrorBoundary>
          <Slideshow onShowNav={() => navigate('/manage')} />
        </ErrorBoundary>
        {setup.state?.showOfflineBanner && (
          <div
            style={{
              position: 'fixed',
              bottom: 8,
              right: 8,
              padding: '4px 10px',
              fontSize: 14,
              color: '#f1f3f5',
              background: 'rgba(0, 0, 0, 0.55)',
              borderRadius: 6,
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          >
            No WiFi — showing saved photos
          </div>
        )}
        {!displayOn && <div className="display-blanket" />}
      </Box>
    )
  }

  return (
    <AppShell
      header={{ height: 70 }}
      padding="md"
    >
      <Navigation />
      <AppShell.Main>
        <Routes>
          <Route path="/slideshow" element={
            <ErrorBoundary>
              <Slideshow onShowNav={() => navigate('/manage')} />
            </ErrorBoundary>
          } />
          <Route path="/manage" element={<Admin />} />
          <Route path="/" element={<Navigate to="/manage" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  )
}

function App() {
  return (
    <BrowserRouter>
      <WebSocketProvider>
        <AppContent />
      </WebSocketProvider>
    </BrowserRouter>
  )
}

export default App
