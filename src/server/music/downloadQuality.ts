export const DOWNLOAD_QUALITY_PRIORITY = [
  'master',
  'atmos_plus',
  'atmos',
  'hires',
  'flac24bit',
  'flac',
  '320k',
  '192k',
  '128k',
] as const

export const getDownloadQualityCandidates = (requestedQuality: string) => {
  const index = DOWNLOAD_QUALITY_PRIORITY.indexOf(requestedQuality as typeof DOWNLOAD_QUALITY_PRIORITY[number])
  if (index < 0) return [requestedQuality]
  return DOWNLOAD_QUALITY_PRIORITY.slice(index)
}

/** 音质排名，越小越好；未知音质排最后，竞速择优时不会压过已知音质。 */
export const getQualityRank = (quality: string): number => {
  const index = DOWNLOAD_QUALITY_PRIORITY.indexOf(quality as typeof DOWNLOAD_QUALITY_PRIORITY[number])
  return index >= 0 ? index : DOWNLOAD_QUALITY_PRIORITY.length
}

export const resolveWithQualityFallback = async <T extends { url?: string, type?: string }>(
  requestedQuality: string,
  resolve: (quality: string) => Promise<T>,
) => {
  const errors: string[] = []

  for (const quality of getDownloadQualityCandidates(requestedQuality)) {
    try {
      const result = await resolve(quality)
      if (!result?.url) throw new Error('cannot resolve download URL')
      return {
        result,
        quality: result.type || quality,
      }
    } catch (err: any) {
      errors.push(`${quality}: ${err?.message || 'resolve failed'}`)
    }
  }

  throw new Error(`Selected quality and all lower qualities failed (${errors.join('; ')})`)
}
