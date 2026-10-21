import { useEffect } from 'react'

import { openSeriesFromNotice, watchNewEpisodes } from '../lib/newEpisodes'
import { useSession } from '../state/store'

/** In the app: checks for new episodes in the background, whatever tool is open. */
export function useNewEpisodes(): void {
  const setPanel = useSession((state) => state.setPanel)
  useEffect(() => watchNewEpisodes(openSeriesFromNotice(setPanel)), [setPanel])
}
