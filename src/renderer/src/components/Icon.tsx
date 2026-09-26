// One consistent stroke icon set (1.6px stroke, 16px grid), drawn inline.
const PATHS = {
  minimize: 'M3.5 12.5h9',
  release: 'M9.5 3.5h3v3M12.5 3.5 7 9M11 9.5v3H3.5V5H6.5',
  maximize: 'M3.5 3.5h9v9h-9z',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3.5v9M3.5 8h9',
  agent: 'M2.5 4.5 6 8l-3.5 3.5M8 12h5.5',
  stop: 'M4.5 4.5h7v7h-7z',
  capture: 'M5.5 3.5h8v9h-8M1.5 8h7M6 5.5 8.5 8 6 10.5',
  layers: 'M8 2.5 13.5 5.5 8 8.5 2.5 5.5zM2.5 8.5 8 11.5l5.5-3',
  focus: 'M2.5 3.5h7v9h-7zM11.5 3.5h2M11.5 7h2M11.5 10.5h2',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  free: 'M2.5 3.5h7v5h-7zM6.5 8.5h7v5h-7z',
  tabs: 'M2.5 5.5h11v8h-11zM2.5 5.5v-2h4v2M7.5 5.5v-2h4v2',
  settings: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3'
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
