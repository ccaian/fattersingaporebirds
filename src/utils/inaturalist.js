const obsCache = new Map()
const taxonCache = new Map()

// iNaturalist standard place IDs
const PLACE_IDS = {
  singapore: ['6734'],
  borneo: ['7319', '7045', '7145', '7237'], // Sabah, Sarawak, Kalimantan, Brunei
}

function buildPlaceIdParam(regions) {
  const ids = []
  if (regions?.singapore) ids.push(...PLACE_IDS.singapore)
  if (regions?.borneo) ids.push(...PLACE_IDS.borneo)
  return ids.join(',')
}

async function queryObservations(sciName, placeIdParam) {
  const params = new URLSearchParams({
    taxon_name: sciName,
    quality_grade: 'research',
    photos: 'true',
    per_page: '10',
    order_by: 'votes',
    order: 'desc',
  })

  if (placeIdParam) {
    params.set('place_id', placeIdParam)
  }

  const res = await fetch(
    `https://api.inaturalist.org/v1/observations?${params.toString()}`
  )
  if (!res.ok) {
    throw new Error(`iNaturalist API error: ${res.status}`)
  }

  const data = await res.json()
  return (data.results || []).filter(
    (obs) => obs.photos && obs.photos.length > 0
  )
}

/**
 * Fetch a random Research Grade, top-voted observation photo for a snake,
 * filtered by selected regions (Singapore / Borneo) with a global fallback.
 */
export async function fetchSnakeRoundData(
  snake,
  regions = { singapore: true, borneo: true }
) {
  const sciName = snake.scientific_name
  const placeIdParam = buildPlaceIdParam(regions)
  const cacheKey = `${sciName}::${placeIdParam || 'global'}`

  let observations = obsCache.get(cacheKey)

  if (!observations) {
    observations = await queryObservations(sciName, placeIdParam)

    // Fallback to global Research Grade photos if none exist in the selected region(s)
    if (observations.length === 0 && placeIdParam) {
      observations = await queryObservations(sciName, '')
    }

    obsCache.set(cacheKey, observations)
  }

  if (observations.length === 0) {
    return null
  }

  const chosenObs =
    observations[Math.floor(Math.random() * observations.length)]
  const chosenPhoto =
    chosenObs.photos[Math.floor(Math.random() * chosenObs.photos.length)]

  const photoUrl = chosenPhoto.url.replace('square', 'large')
  const placeGuess = chosenObs.place_guess || 'Location not recorded'
  const photographer = chosenObs.user?.login || 'unknown'

  let conservationStatus =
    chosenObs.taxon?.conservation_status?.status_name || null
  let wikipediaSummary = chosenObs.taxon?.wikipedia_summary || null

  const taxonId = chosenObs.taxon?.id
  if (taxonId && (!wikipediaSummary || !conservationStatus)) {
    let taxonDetails = taxonCache.get(taxonId)
    if (!taxonDetails) {
      try {
        const taxonRes = await fetch(
          `https://api.inaturalist.org/v1/taxa/${taxonId}`
        )
        if (taxonRes.ok) {
          const taxonJson = await taxonRes.json()
          taxonDetails = taxonJson.results?.[0] || null
          taxonCache.set(taxonId, taxonDetails)
        }
      } catch {
        // Ignore secondary taxon lookup failures
      }
    }

    if (taxonDetails) {
      if (!wikipediaSummary && taxonDetails.wikipedia_summary) {
        wikipediaSummary = taxonDetails.wikipedia_summary
      }
      if (!conservationStatus) {
        const cs =
          taxonDetails.conservation_status ||
          taxonDetails.conservation_statuses?.[0]
        if (cs) {
          conservationStatus = cs.status_name || cs.status || null
        }
      }
    }
  }

  const cleanSummary = wikipediaSummary
    ? wikipediaSummary.replace(/<[^>]*>/g, '').trim()
    : 'No Wikipedia summary available for this species.'

  return {
    photoUrl,
    placeGuess,
    photographer,
    conservationStatus: conservationStatus || 'Not Evaluated / Unlisted',
    wikipediaSummary: cleanSummary,
    observationUrl: `https://www.inaturalist.org/observations/${chosenObs.id}`,
  }
}