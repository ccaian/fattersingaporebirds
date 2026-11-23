const obsCache = new Map()
const taxonCache = new Map()

// iNaturalist standard place IDs
const PLACE_IDS = {
  singapore: ['6734'],
  borneo: ['7319', '7045', '7145', '7237'], // Sabah, Sarawak, Kalimantan, Brunei
}

// Keywords indicating dead/roadkill specimens or multi-species predation scenes
const EXCLUDED_KEYWORDS = [
  'roadkill',
  'road kill',
  'dor',
  'dead on road',
  'dead',
  'carcass',
  'flattened',
  'run over',
  'ran over',
  'squashed',
  'predation',
  'eating',
  'swallowing',
  'feeding on',
  'prey',
]

const KEYWORD_REGEX = new RegExp(
  `\\b(${EXCLUDED_KEYWORDS.map((k) => k.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i'
)

function buildPlaceIdParam(regions) {
  const ids = []
  if (regions?.singapore) ids.push(...PLACE_IDS.singapore)
  if (regions?.borneo) ids.push(...PLACE_IDS.borneo)
  return ids.join(',')
}

function isLiveSingleSpecimen(obs) {
  // 1. Reject any observation annotated as Dead (term_id = 17, term_value_id = 19)
  //    or Cannot Be Determined (term_value_id = 20)
  if (Array.isArray(obs.annotations)) {
    const isDeadOrUnknown = obs.annotations.some(
      (ann) =>
        ann.controlled_attribute_id === 17 &&
        (ann.controlled_value_id === 19 || ann.controlled_value_id === 20)
    )
    if (isDeadOrUnknown) return false
  }

  // 2. Reject observations whose description, tags, observation fields, or comments
  //    mention roadkill/dead/predation keywords
  const textParts = []
  if (obs.description) textParts.push(obs.description)
  if (Array.isArray(obs.tags)) textParts.push(...obs.tags)
  if (Array.isArray(obs.comments)) {
    for (const c of obs.comments) {
      if (c?.body) textParts.push(c.body)
    }
  }
  if (Array.isArray(obs.ofvs)) {
    for (const field of obs.ofvs) {
      if (field?.name) textParts.push(field.name)
      if (field?.value) textParts.push(String(field.value))
    }
  }

  const combinedText = textParts.join(' ')
  if (combinedText && KEYWORD_REGEX.test(combinedText)) {
    return false
  }

  return true
}

async function queryObservations(sciName, placeIdParam) {
  const params = new URLSearchParams({
    taxon_name: sciName,
    quality_grade: 'research',
    photos: 'true',
    without_term_value_id: '19', // Exclude observations explicitly annotated as Dead
    per_page: '20',
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
  const withPhotos = (data.results || []).filter(
    (obs) => obs.photos && obs.photos.length > 0
  )

  const liveFiltered = withPhotos.filter(isLiveSingleSpecimen)

  // Fall back to unfiltered results only if filtering leaves 0 candidates
  return liveFiltered.length > 0 ? liveFiltered : withPhotos
}

/**
 * Fetch a random Research Grade, top-voted observation photo for a snake,
 * filtered by selected regions (Singapore / Borneo) and excluding dead/roadkill/predation
 * observations, with a global fallback.
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