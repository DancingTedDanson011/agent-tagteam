import type { OrganizerApi } from '../shared/types'

declare global {
  interface Window {
    organizer: OrganizerApi
  }
}

export {}
