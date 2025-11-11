import { Component, ReactNode } from 'react'
import { Stack, Text, Box } from '@mantine/core'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <Box 
          style={{ 
            width: '100vw', 
            height: '100vh', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            background: '#000'
          }}
        >
          <Stack align="center" gap="md">
            <Text size="xl" c="white" fw={500}>
              Slideshow Error
            </Text>
            <Text size="sm" c="dimmed" style={{ maxWidth: 400, textAlign: 'center' }}>
              {this.state.error?.message || 'An unexpected error occurred'}
            </Text>
            <Text size="xs" c="dimmed">
              The slideshow will attempt to recover automatically
            </Text>
          </Stack>
        </Box>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary

