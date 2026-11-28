import './App.css'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  fetchSnakeRoundData,
  loadBlacklist,
  addToBlacklist,
} from './utils/inaturalist'

const ROUND_OPTIONS = [20, 50, 100, 'All']
const RARITY_LEVELS = ['Very Common', 'Common', 'Uncommon', 'Rare', 'Very Rare']
const SNAKE_BUFFER_SIZE = 2

function parseLocalStatus(localStatusRaw) {
  if (!localStatusRaw || typeof localStatusRaw !== 'string') return null
  const status = localStatusRaw.trim().toLowerCase()
  if (!status) return null

  if (status.includes('vagrant')) {
    return { category: 'vagrants', rarity: null }
  }

  const isLocal = status.includes('resident') || status.includes('introduced')
  const isMigrant = status.includes('migrant') || status.includes('visitor')
  if (!isLocal && !isMigrant) return null

  let rarity = null
  if (status.includes('very rare')) {
    rarity = 'Very Rare'
  } else if (status.includes('uncommon')) {
    rarity = 'Uncommon'
  } else if (status.includes('rare')) {
    rarity = 'Rare'
  } else if (status.includes('very common')) {
    rarity = 'Very Common'
  } else if (status.includes('common')) {
    rarity = 'Common'
  }

  if (!rarity) return null

  return {
    category: isLocal ? 'local' : 'migrant',
    rarity,
  }
}

function normalizeName(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesStatusFilter(localStatusRaw, filters) {
  const parsed = parseLocalStatus(localStatusRaw)
  if (!parsed) return false

  if (parsed.category === 'vagrants') {
    return filters.vagrants
  }
  return filters[parsed.category].includes(parsed.rarity)
}

function preloadImageUrl(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
}

function App() {
  const [screen, setScreen] = useState('start') // 'start' | 'playing' | 'summary'
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState('photo')

  // Game Category Mascot Selector ('bird' | 'snake')
  const [gameCategory, setGameCategory] = useState('bird')
  const [hoveredCategory, setHoveredCategory] = useState(null)

  // Shared Rounds Setting
  const [maxRounds, setMaxRounds] = useState(20)

  // Bird Settings State
  const [statusFilters, setStatusFilters] = useState({
    local: ['Very Common', 'Common'],
    migrant: ['Very Common', 'Common'],
    vagrants: false,
  })

  // Snake Settings State
  const [snakeRegions, setSnakeRegions] = useState({
    singapore: true,
    borneo: true,
  })
  const [snakeNameMode, setSnakeNameMode] = useState('both') // 'both' | 'scientific'

  // Datasets
  const [birds, setBirds] = useState([])
  const [snakes, setSnakes] = useState([])

  // Active Session State
  const [sessionQueue, setSessionQueue] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [score, setScore] = useState(0)
  const [snakeMediaMap, setSnakeMediaMap] = useState({})
  const fetchingIndicesRef = useRef(new Set())

  // Startup Pre-warm Buffer (holds up to 2 ready-to-play snake rounds before game starts)
  const prewarmBufferRef = useRef([])
  const isPrewarmingRef = useRef(false)
  const prewarmGenRef = useRef(0)

  // Guessing, Autocomplete & Pop-up Modals State
  const [guess, setGuess] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [roundResult, setRoundResult] = useState(null)
  const [hideRevealBanner, setHideRevealBanner] = useState(false)
  const [showIdModal, setShowIdModal] = useState(false)
  const [showReportModal, setShowReportModal] = useState(false)
  const [reportedCurrentPhoto, setReportedCurrentPhoto] = useState(false)

  // Set CSS variable for full-screen pixel background (used by body::before)
  useEffect(() => {
    const bgUrl = `${import.meta.env.BASE_URL}background/pixel.png`
    document.body.style.setProperty('--bg-image', `url("${bgUrl}")`)
  }, [])

  // Preload Cloudflare blacklist on startup
  useEffect(() => {
    loadBlacklist()
  }, [])

  // Load birds.json
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}birdphotos/birds.json`)
      .then((res) => res.json())
      .then((data) => {
        const validBirds = data.filter(
          (b) =>
            b.photos &&
            b.photos.length > 0 &&
            parseLocalStatus(b.local_status) !== null
        )
        setBirds(validBirds)
      })
      .catch((err) => console.error('Failed to load birds.json:', err))
  }, [])

  // Load snakes.json from public/snakes.json
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}snakes.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        const validSnakes = data
          .filter((s) => s.scientific_name && s.common_name)
          .map((s) => {
            const rawCountries = Array.isArray(s.countries)
              ? s.countries
              : typeof s.country === 'string'
              ? [s.country]
              : []
            return {
              ...s,
              countries: rawCountries.map((c) => c.trim().toLowerCase()),
            }
          })
        setSnakes(validSnakes)
      })
      .catch((err) => console.error('Failed to load snakes.json:', err))
  }, [])

  const filteredBirds = useMemo(() => {
    return birds.filter((bird) =>
      matchesStatusFilter(bird.local_status, statusFilters)
    )
  }, [birds, statusFilters])

  const filteredSnakes = useMemo(() => {
    return snakes.filter((snake) => {
      if (snakeRegions.singapore && snake.countries.includes('singapore')) {
        return true
      }
      if (snakeRegions.borneo && snake.countries.includes('borneo')) {
        return true
      }
      return false
    })
  }, [snakes, snakeRegions])

  const activeRegionKey = `${snakeRegions.singapore ? 'sg' : ''}-${
    snakeRegions.borneo ? 'bo' : ''
  }`

  // Preload up to 2 snake photos in the background matching current region selection
  const topUpStartupSnakeBuffer = useCallback(async () => {
    if (isPrewarmingRef.current || filteredSnakes.length === 0) return

    prewarmBufferRef.current = prewarmBufferRef.current.filter(
      (entry) => entry.regionKey === activeRegionKey
    )

    if (prewarmBufferRef.current.length >= SNAKE_BUFFER_SIZE) return

    const generation = prewarmGenRef.current
    const snapshotRegions = { ...snakeRegions }
    const snapshotPool = [...filteredSnakes]
    const snapshotKey = activeRegionKey

    isPrewarmingRef.current = true
    try {
      let attempts = 0
      while (
        prewarmBufferRef.current.length < SNAKE_BUFFER_SIZE &&
        attempts < 8
      ) {
        if (prewarmGenRef.current !== generation) return

        attempts += 1
        const usedNames = new Set(
          prewarmBufferRef.current.map((item) => item.snake.scientific_name)
        )
        const candidates = snapshotPool.filter(
          (s) => !usedNames.has(s.scientific_name)
        )
        const pool = candidates.length > 0 ? candidates : snapshotPool
        const randomSnake = pool[Math.floor(Math.random() * pool.length)]

        const data = await fetchSnakeRoundData(randomSnake, snapshotRegions)

        if (prewarmGenRef.current !== generation) return

        if (data && data.photoUrl) {
          await preloadImageUrl(data.photoUrl)
          if (prewarmGenRef.current !== generation) return
          prewarmBufferRef.current.push({
            snake: randomSnake,
            data,
            regionKey: snapshotKey,
          })
        }
      }
    } catch (err) {
      console.error('Background snake prewarm failed:', err)
    } finally {
      isPrewarmingRef.current = false
      if (prewarmGenRef.current !== generation) {
        topUpStartupSnakeBuffer()
      }
    }
  }, [filteredSnakes, snakeRegions, activeRegionKey])

  useEffect(() => {
    prewarmGenRef.current += 1
    prewarmBufferRef.current = prewarmBufferRef.current.filter(
      (entry) => entry.regionKey === activeRegionKey
    )

    if (screen === 'start' && filteredSnakes.length > 0) {
      topUpStartupSnakeBuffer()
    }
  }, [screen, filteredSnakes, activeRegionKey, topUpStartupSnakeBuffer])

  const toggleRarity = (group, level) => {
    setStatusFilters((prev) => {
      const exists = prev[group].includes(level)
      const updated = exists
        ? prev[group].filter((item) => item !== level)
        : [...prev[group], level]
      return { ...prev, [group]: updated }
    })
  }

  // Fetch & preload snake iNaturalist photo for a specific queue index
  const ensureSnakeRoundLoaded = useCallback(
    async (queue, idx, options = {}) => {
      if (idx >= queue.length) return
      if (fetchingIndicesRef.current.has(idx)) return

      fetchingIndicesRef.current.add(idx)

      try {
        const data = await fetchSnakeRoundData(
          queue[idx].snake,
          snakeRegions,
          options
        )
        if (data && data.photoUrl) {
          await preloadImageUrl(data.photoUrl)
          setSnakeMediaMap((prev) => ({ ...prev, [idx]: data }))
        } else {
          setSnakeMediaMap((prev) => ({ ...prev, [idx]: 'empty' }))
        }
      } catch (err) {
        console.error('Snake photo fetch failed:', err)
        setSnakeMediaMap((prev) => ({ ...prev, [idx]: 'empty' }))
      } finally {
        fetchingIndicesRef.current.delete(idx)
      }
    },
    [snakeRegions]
  )

  // Rolling 2-snake lookahead cache while playing
  useEffect(() => {
    if (screen !== 'playing' || gameCategory !== 'snake') return
    if (sessionQueue.length === 0) return

    const currentEntry = snakeMediaMap[currentIndex]

    if (currentEntry === 'empty') {
      if (currentIndex + 1 >= sessionQueue.length) {
        setScreen('summary')
      } else {
        setCurrentIndex((prev) => prev + 1)
      }
      return
    }

    for (let offset = 0; offset <= SNAKE_BUFFER_SIZE; offset += 1) {
      const targetIdx = currentIndex + offset
      if (targetIdx < sessionQueue.length && !snakeMediaMap[targetIdx]) {
        ensureSnakeRoundLoaded(sessionQueue, targetIdx)
      }
    }
  }, [
    screen,
    gameCategory,
    sessionQueue,
    currentIndex,
    snakeMediaMap,
    ensureSnakeRoundLoaded,
  ])

  const startNewGame = () => {
    setMenuOpen(false)
    if (gameCategory === 'bird') {
      if (filteredBirds.length === 0) return

      const shuffled = [...filteredBirds]
        .sort(() => Math.random() - 0.5)
        .map((bird) => ({
          bird,
          photo: bird.photos[Math.floor(Math.random() * bird.photos.length)],
        }))

      const limitedQueue =
        maxRounds === 'All' ? shuffled : shuffled.slice(0, maxRounds)

      setSessionQueue(limitedQueue)
      setCurrentIndex(0)
      setScore(0)
      setGuess('')
      setRoundResult(null)
      setHideRevealBanner(false)
      setShowIdModal(false)
      setShowReportModal(false)
      setReportedCurrentPhoto(false)
      setScreen('playing')
    } else {
      if (filteredSnakes.length === 0) return

      const targetCount =
        maxRounds === 'All'
          ? filteredSnakes.length
          : Math.min(maxRounds, filteredSnakes.length)

      const matchingWarmed = prewarmBufferRef.current.filter(
        (item) => item.regionKey === activeRegionKey
      )
      prewarmBufferRef.current = []

      const warmedEntries = matchingWarmed.slice(
        0,
        Math.min(SNAKE_BUFFER_SIZE, targetCount)
      )
      const warmedNames = new Set(
        warmedEntries.map((item) => item.snake.scientific_name)
      )

      const remainingShuffled = filteredSnakes
        .filter((s) => !warmedNames.has(s.scientific_name))
        .sort(() => Math.random() - 0.5)
        .map((snake) => ({ snake }))

      const fullQueue = [
        ...warmedEntries.map((item) => ({ snake: item.snake })),
        ...remainingShuffled,
      ].slice(0, targetCount)

      const initialMediaMap = {}
      warmedEntries.forEach((item, idx) => {
        initialMediaMap[idx] = item.data
      })

      fetchingIndicesRef.current.clear()
      setSnakeMediaMap(initialMediaMap)
      setSessionQueue(fullQueue)
      setCurrentIndex(0)
      setScore(0)
      setGuess('')
      setRoundResult(null)
      setHideRevealBanner(false)
      setShowIdModal(false)
      setShowReportModal(false)
      setReportedCurrentPhoto(false)
      setScreen('playing')
    }
  }

  const currentRound = sessionQueue[currentIndex] || null
  const currentSnakeData =
    gameCategory === 'snake' &&
    snakeMediaMap[currentIndex] &&
    snakeMediaMap[currentIndex] !== 'empty'
      ? snakeMediaMap[currentIndex]
      : null

  const isSnakeLoading = gameCategory === 'snake' && !currentSnakeData

  const handleRefreshPhoto = () => {
    setMenuOpen(false)
    if (!currentRound) return

    if (gameCategory === 'bird') {
      const photos = currentRound.bird.photos || []
      if (photos.length <= 1) return

      const alternatives = photos.filter(
        (p) => p.local_path !== currentRound.photo.local_path
      )
      const pool = alternatives.length > 0 ? alternatives : photos
      const nextPhoto = pool[Math.floor(Math.random() * pool.length)]

      setSessionQueue((prev) =>
        prev.map((item, idx) =>
          idx === currentIndex ? { ...item, photo: nextPhoto } : item
        )
      )
    } else {
      const prevObsId = currentSnakeData?.observationId
      setReportedCurrentPhoto(false)
      fetchingIndicesRef.current.delete(currentIndex)
      setSnakeMediaMap((prev) => {
        const updated = { ...prev }
        delete updated[currentIndex]
        return updated
      })
      ensureSnakeRoundLoaded(
        sessionQueue,
        currentIndex,
        prevObsId ? { excludeObservationIds: [prevObsId] } : {}
      )
    }
  }

  const nextRound = () => {
    setMenuOpen(false)
    setShowIdModal(false)
    setShowReportModal(false)
    setReportedCurrentPhoto(false)
    setHideRevealBanner(false)
    setShowDropdown(false)
    setGuess('')
    setRoundResult(null)

    if (currentIndex + 1 >= sessionQueue.length) {
      setScreen('summary')
    } else {
      setCurrentIndex((prev) => prev + 1)
    }
  }

  const suggestions = useMemo(() => {
    const query = normalizeName(guess)
    if (!query) return []

    if (gameCategory === 'bird') {
      return birds
        .map((b) => ({
          value: b.bird_name,
          primary: b.bird_name,
          secondary: null,
        }))
        .filter((item) => normalizeName(item.primary).includes(query))
        .slice(0, 8)
    }

    return snakes
      .filter((s) => {
        if (snakeNameMode === 'scientific') {
          return normalizeName(s.scientific_name).includes(query)
        }
        return (
          normalizeName(s.common_name).includes(query) ||
          normalizeName(s.scientific_name).includes(query)
        )
      })
      .map((s) =>
        snakeNameMode === 'scientific'
          ? {
              value: s.scientific_name,
              primary: s.scientific_name,
              secondary: null,
            }
          : {
              value: s.common_name,
              primary: s.common_name,
              secondary: s.scientific_name,
            }
      )
      .slice(0, 8)
  }, [guess, gameCategory, birds, snakes, snakeNameMode])

  const checkAnswer = (submittedText) => {
    if (!currentRound || roundResult) return
    const cleaned = normalizeName(submittedText)
    if (!cleaned) return

    let isCorrect = false
    if (gameCategory === 'bird') {
      isCorrect = cleaned === normalizeName(currentRound.bird.bird_name)
    } else {
      const targetCommon = normalizeName(currentRound.snake.common_name)
      const targetSci = normalizeName(currentRound.snake.scientific_name)
      if (snakeNameMode === 'scientific') {
        isCorrect = cleaned === targetSci
      } else {
        isCorrect = cleaned === targetCommon || cleaned === targetSci
      }
    }

    if (isCorrect) {
      setScore((s) => s + 1)
    }
    setHideRevealBanner(false)
    setRoundResult({ correct: isCorrect })
    setShowDropdown(false)
  }

  const handleFormSubmit = (e) => {
    e.preventDefault()
    if (roundResult) {
      nextRound()
      return
    }
    if (showDropdown && suggestions.length > 0) {
      const selected = suggestions[highlightedIndex].value
      setGuess(selected)
      checkAnswer(selected)
    } else {
      checkAnswer(guess)
    }
  }

  const handleKeyDown = (e) => {
    if (!showDropdown || suggestions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) =>
        prev === 0 ? suggestions.length - 1 : prev - 1
      )
    } else if (e.key === 'Escape') {
      setShowDropdown(false)
    }
  }

  const handleBack = () => {
    setMenuOpen(false)
    setShowIdModal(false)
    setShowReportModal(false)
    setReportedCurrentPhoto(false)
    setHideRevealBanner(false)
    setScreen('start')
  }

  const activeBannerWord = (hoveredCategory || gameCategory).toUpperCase()
  const activePoolCount =
    gameCategory === 'bird' ? filteredBirds.length : filteredSnakes.length
  const noRegionSelected =
    gameCategory === 'snake' && !snakeRegions.singapore && !snakeRegions.borneo

  const getStartButtonLabel = () => {
    if (gameCategory === 'bird') {
      if (birds.length === 0) return 'Loading birds.json...'
      if (filteredBirds.length === 0) return 'Select at least 1 status'
    } else {
      if (snakes.length === 0) return 'snakes.json not found in public/'
      if (noRegionSelected) return 'Select at least 1 region'
      if (filteredSnakes.length === 0) return '0 species match selection'
    }

    const roundsCount =
      maxRounds === 'All'
        ? activePoolCount
        : Math.min(maxRounds, activePoolCount)
    return `Start Game (${roundsCount} Rounds)`
  }

  if (screen === 'start') {
    return (
      <div className="start-stage">
        {/* TOP MASCOT SELECTOR BAR */}
        <div className="mode-selector-bar">
          <button
            type="button"
            className={`mode-mascot-btn mode-mascot-btn--bird ${
              gameCategory === 'bird' ? 'mode-mascot-btn--active' : ''
            }`}
            onMouseEnter={() => setHoveredCategory('bird')}
            onMouseLeave={() => setHoveredCategory(null)}
            onClick={() => setGameCategory('bird')}
            title="Select Bird Mode"
          >
            <img
              src={`${import.meta.env.BASE_URL}background/lonktail.png`}
              alt="Bird Mode"
              className="mode-mascot-img"
            />
          </button>

          <div className="mode-pixel-label-slot">
            <span className="mode-pixel-title">{activeBannerWord}</span>
          </div>

          <button
            type="button"
            className={`mode-mascot-btn mode-mascot-btn--snake ${
              gameCategory === 'snake' ? 'mode-mascot-btn--active' : ''
            }`}
            onMouseEnter={() => setHoveredCategory('snake')}
            onMouseLeave={() => setHoveredCategory(null)}
            onClick={() => setGameCategory('snake')}
            title="Select Snake Mode"
          >
            <img
              src={`${import.meta.env.BASE_URL}background/snek.png`}
              alt="Snake Mode"
              className="mode-mascot-img"
            />
          </button>
        </div>

        {/* MAIN START CARD */}
        <main className="game-card">
          <div className="start-header">
            <h2 className="start-title">
              {gameCategory === 'bird' ? `${birds.length} birds here` : `${snakes.length} snakes here`}
            </h2>
            <p className="start-subtitle">
              {gameCategory === 'bird'
                ? `All bird photos taken from Francis Yap©`
                : `All snake photos fetched from the iNaturalist API`}
            </p>
          </div>

          <div className="settings-grid">
            {/* BOX 1: NUMBER OF ROUNDS */}
            <section className="setting-box">
              <h3 className="setting-box-title">Rounds</h3>
              <div className="rounds-options">
                {ROUND_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`choice-tile ${
                      maxRounds === opt ? 'choice-tile--selected' : ''
                    }`}
                    onClick={() => setMaxRounds(opt)}
                  >
                    {opt === 'All' ? 'All!' : opt}
                  </button>
                ))}
              </div>
            </section>

            {/* BOX 2: BIRD LOCAL STATUS OR SNAKE REGION & GUESS MODE */}
            {gameCategory === 'bird' ? (
              <section className="setting-box">
                <h3 className="setting-box-title">Local Status</h3>

                <div className="status-columns">
                  <div>
                    <div className="status-group-header">
                      <span>Local</span>
                    </div>
                    {RARITY_LEVELS.map((level) => (
                      <label key={`local-${level}`} className="checklist-item">
                        <input
                          type="checkbox"
                          checked={statusFilters.local.includes(level)}
                          onChange={() => toggleRarity('local', level)}
                        />
                        <span>{level}</span>
                      </label>
                    ))}
                  </div>

                  <div>
                    <div className="status-group-header">
                      <span>Migrant</span>
                    </div>
                    {RARITY_LEVELS.map((level) => (
                      <label key={`migrant-${level}`} className="checklist-item">
                        <input
                          type="checkbox"
                          checked={statusFilters.migrant.includes(level)}
                          onChange={() => toggleRarity('migrant', level)}
                        />
                        <span>{level}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="vagrant-row">
                  <label className="checklist-item">
                    <input
                      type="checkbox"
                      checked={statusFilters.vagrants}
                      onChange={() =>
                        setStatusFilters((prev) => ({
                          ...prev,
                          vagrants: !prev.vagrants,
                        }))
                      }
                    />
                    <span>Vagrants</span>
                  </label>

                  <span className="pool-counter">
                    {filteredBirds.length} species selected
                  </span>
                </div>
              </section>
            ) : (
              <section className="setting-box">
                <h3 className="setting-box-title">Region & Naming</h3>

                <div className="status-columns">
                  {/* Region Checkboxes */}
                  <div>
                    <div className="status-group-header">
                      <span>Region</span>
                    </div>
                    <label className="checklist-item">
                      <input
                        type="checkbox"
                        checked={snakeRegions.singapore}
                        onChange={() =>
                          setSnakeRegions((prev) => ({
                            ...prev,
                            singapore: !prev.singapore,
                          }))
                        }
                      />
                      <span>Singapore</span>
                    </label>
                    <label className="checklist-item">
                      <input
                        type="checkbox"
                        checked={snakeRegions.borneo}
                        onChange={() =>
                          setSnakeRegions((prev) => ({
                            ...prev,
                            borneo: !prev.borneo,
                          }))
                        }
                      />
                      <span>Borneo</span>
                    </label>
                  </div>

                  {/* Naming Mode Selection */}
                  <div>
                    <div className="status-group-header">
                      <span>Guess Mode</span>
                    </div>
                    <div className="snake-name-options">
                      <button
                        type="button"
                        className={`choice-tile choice-tile--compact ${
                          snakeNameMode === 'both' ? 'choice-tile--selected' : ''
                        }`}
                        onClick={() => setSnakeNameMode('both')}
                      >
                        Common + Sci
                      </button>
                      <button
                        type="button"
                        className={`choice-tile choice-tile--compact ${
                          snakeNameMode === 'scientific'
                            ? 'choice-tile--selected'
                            : ''
                        }`}
                        onClick={() => setSnakeNameMode('scientific')}
                      >
                        Scientific Only
                      </button>
                    </div>
                  </div>
                </div>

                <div className="vagrant-row">
                  <span className="pool-counter">
                    {filteredSnakes.length} species selected
                  </span>
                </div>
              </section>
            )}
          </div>

          <div className="card-footer">
            <button
              type="button"
              className="primary-button"
              onClick={startNewGame}
              disabled={activePoolCount === 0}
            >
              {getStartButtonLabel()}
            </button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <main className={`game-card ${screen === 'playing' ? 'game-card--playing' : ''}`}>
      {screen === 'playing' && currentRound && (
        <>
          {/* 1. TOP 3-PART HEADER */}
          <header className="play-header">
            <button
              type="button"
              className="header-icon-btn header-icon-btn--left"
              onClick={handleBack}
              title="Back to Start"
            >
              ←
            </button>

            <div className="header-title-box">
              <span className="header-subtitle">
                ROUND {currentIndex + 1} OF {sessionQueue.length} • SCORE: {score}
              </span>
              <span className="header-title">
                {!roundResult ? (
                  gameCategory === 'bird' ? (
                    'Mystery Bird'
                  ) : (
                    'Mystery Snake'
                  )
                ) : gameCategory === 'bird' ? (
                  currentRound.bird.bird_name
                ) : snakeNameMode === 'scientific' ? (
                  currentRound.snake.scientific_name
                ) : (
                  <span className="dual-name-inline">
                    <span className="species-common-name">
                      {currentRound.snake.common_name}
                    </span>
                    <span className="species-sci-name">
                      {currentRound.snake.scientific_name}
                    </span>
                  </span>
                )}
              </span>
            </div>

            <button
              type="button"
              className="header-icon-btn header-icon-btn--right"
              onClick={() => setMenuOpen((prev) => !prev)}
              title="Menu"
            >
              ☰
            </button>
          </header>

          {/* Hamburger Dropdown Menu */}
          {menuOpen && (
            <nav className="header-menu">
              {!roundResult ? (
                <button
                  type="button"
                  className="menu-item"
                  onClick={handleRefreshPhoto}
                  disabled={gameCategory === 'snake' && isSnakeLoading}
                >
                  Refresh Photo
                </button>
              ) : (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setHideRevealBanner((prev) => !prev)
                    setMenuOpen(false)
                  }}
                >
                  {hideRevealBanner ? 'Show Info Box' : 'Hide Info Box'}
                </button>
              )}

              {gameCategory === 'snake' && currentSnakeData?.observationId && (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowReportModal(true)
                  }}
                >
                  {reportedCurrentPhoto
                    ? 'Photo Reported ✓'
                    : 'Report Invalid Photo'}
                </button>
              )}

            </nav>
          )}

          {/* 2. MIDDLE PHOTO / MEDIA BOX */}
          <section
            className={`photo-box ${isSnakeLoading ? 'photo-box--loading' : ''}`}
          >
            {gameCategory === 'bird' ? (
              mode === 'photo' ? (
                <>
                  <img
                    src={`${import.meta.env.BASE_URL}birdphotos/${currentRound.photo.local_path}`}
                    alt=""
                    aria-hidden="true"
                    className="photo-backdrop"
                  />
                  <img
                    src={`${import.meta.env.BASE_URL}birdphotos/${currentRound.photo.local_path}`}
                    alt="Mystery bird"
                    className="photo-foreground"
                  />
                </>
              ) : (
                <button type="button" className="primary-button">
                  ▶ Play Bird Call (Coming Soon)
                </button>
              )
            ) : currentSnakeData ? (
              <>
                <img
                  src={currentSnakeData.photoUrl}
                  alt=""
                  aria-hidden="true"
                  className="photo-backdrop"
                />
                <img
                  src={currentSnakeData.photoUrl}
                  alt="Mystery snake"
                  className="photo-foreground"
                />
              </>
            ) : (
              <div className="loading-video-wrapper">
                <video
                  src={`${import.meta.env.BASE_URL}threedotload.webm`}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="loading-video"
                />
              </div>
            )}

            {/* Answer Reveal Banner */}
            {roundResult && !hideRevealBanner && (
              <div className="reveal-banner">
                <div className="reveal-details">
                  <div className="reveal-status-row">
                    <span
                      className={`status-tag ${
                        roundResult.correct
                          ? 'status-tag--correct'
                          : 'status-tag--wrong'
                      }`}
                    >
                      {roundResult.correct ? 'Correct' : 'Incorrect'}
                    </span>

                    {gameCategory === 'bird' ? (
                      <span className="reveal-bird-name">
                        {currentRound.bird.bird_name}
                      </span>
                    ) : snakeNameMode === 'scientific' ? (
                      <span className="reveal-bird-name">
                        {currentRound.snake.scientific_name}
                      </span>
                    ) : (
                      <span className="dual-name-inline">
                        <span className="species-common-name">
                          {currentRound.snake.common_name}
                        </span>
                        <span className="species-sci-name">
                          {currentRound.snake.scientific_name}
                        </span>
                      </span>
                    )}
                  </div>

                  {gameCategory === 'bird' ? (
                    <>
                      <div className="reveal-caption">
                        {currentRound.photo.caption}
                      </div>
                      <div className="reveal-local-status">
                        {currentRound.bird.local_status}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="reveal-caption">
                        {currentSnakeData?.placeGuess}
                      </div>
                      <div className="reveal-meta-row">
                        <span className="reveal-local-status">
                          {currentRound.snake.countries.join(' • ')}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  className="info-icon-btn"
                  onClick={() => setShowIdModal(true)}
                  title="View Field Guide Details"
                >
                  i
                </button>
              </div>
            )}

            {/* Identification / Taxon Details Pop-up Modal */}
            {showIdModal && (
              <div
                className="id-modal-backdrop"
                onClick={() => setShowIdModal(false)}
              >
                <div
                  className="id-modal"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="id-modal-header">
                    <span>
                      {gameCategory === 'bird'
                        ? 'Field Guide • Identification'
                        : 'Field Guide • Taxon Info'}
                    </span>
                    <button
                      type="button"
                      className="id-modal-close"
                      onClick={() => setShowIdModal(false)}
                    >
                      ✕
                    </button>
                  </div>

                  {gameCategory === 'bird' ? (
                    <div className="id-modal-body">
                      <div className="id-modal-meta">
                        {currentRound.bird.bird_name}
                      </div>
                      <p>
                        {currentRound.bird.identification ||
                          'No identification notes available for this species.'}
                      </p>
                    </div>
                  ) : (
                    <div className="id-modal-body">
                      <div className="id-modal-meta">
                        {snakeNameMode === 'scientific' ? (
                          <span>{currentRound.snake.scientific_name}</span>
                        ) : (
                          <span className="dual-name-inline">
                            <span className="species-common-name">
                              {currentRound.snake.common_name}
                            </span>
                            <span className="species-sci-name">
                              {currentRound.snake.scientific_name}
                            </span>
                          </span>
                        )}
                      </div>

                      <div className="snake-modal-fields">
                        <div>
                          <strong>Conservation Status:</strong>{' '}
                          {currentSnakeData?.conservationStatus || 'Unknown'}
                        </div>
                        <div>
                          <strong>Observation Location:</strong>{' '}
                          {currentSnakeData?.placeGuess || 'Unknown'}
                        </div>
                        <div>
                          <strong>Photographer:</strong> @
                          {currentSnakeData?.photographer || 'unknown'}
                        </div>
                      </div>

                      <p className="snake-wiki-summary">
                        {currentSnakeData?.wikipediaSummary}
                      </p>

                      {currentSnakeData?.observationUrl && (
                        <a
                          href={currentSnakeData.observationUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inat-link"
                        >
                          View on iNaturalist ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Report Invalid Photo Modal */}
            {showReportModal && gameCategory === 'snake' && currentSnakeData && (
              <div
                className="id-modal-backdrop"
                onClick={() => setShowReportModal(false)}
              >
                <div
                  className="id-modal"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="id-modal-header">
                    <span>Report Invalid Photo</span>
                    <button
                      type="button"
                      className="id-modal-close"
                      onClick={() => setShowReportModal(false)}
                    >
                      ✕
                    </button>
                  </div>

                  <div className="id-modal-body">
                    <div className="id-modal-meta">
                      Observation #{currentSnakeData.observationId} •{' '}
                      {currentRound.snake.scientific_name}
                    </div>

                    {reportedCurrentPhoto ? (
                      <p className="report-confirmation">
                        Blacklisted! This photo will be skipped in future rounds.
                      </p>
                    ) : (
                      <div className="report-reason-list">
                        {[
                          'Roadkill / Dead',
                          'Predation / Feeding',
                          'Multiple Subjects',
                          'Other / Unidentifiable',
                        ].map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            className="choice-tile choice-tile--compact"
                            onClick={() => {
                              addToBlacklist({
                                observationId: currentSnakeData.observationId,
                                scientificName: currentRound.snake.scientific_name,
                                reason,
                              })
                              prewarmBufferRef.current =
                                prewarmBufferRef.current.filter(
                                  (item) =>
                                    item.data?.observationId !==
                                    currentSnakeData.observationId
                                )
                              setReportedCurrentPhoto(true)
                            }}
                          >
                            {reason}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3. BOTTOM CONTROLS BOX */}
          <form className="controls-box" onSubmit={handleFormSubmit}>
            <div className="autocomplete-wrapper">
              {showDropdown && suggestions.length > 0 && !roundResult && (
                <ul className="autocomplete-list">
                  {suggestions.map((item, idx) => (
                    <li
                      key={`${item.value}-${idx}`}
                      className={`autocomplete-item ${
                        idx === highlightedIndex ? 'autocomplete-item--active' : ''
                      }`}
                      onMouseDown={() => {
                        setGuess(item.value)
                        setShowDropdown(false)
                      }}
                    >
                      {item.secondary ? (
                        <span className="dual-name-inline">
                          <span className="species-common-name">
                            {item.primary}
                          </span>
                          <span className="species-sci-name">
                            {item.secondary}
                          </span>
                        </span>
                      ) : (
                        item.primary
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <input
                type="text"
                className="guess-input"
                placeholder={
                  gameCategory === 'bird'
                    ? 'Type bird name...'
                    : snakeNameMode === 'scientific'
                    ? 'Type scientific name...'
                    : 'Type common or scientific name...'
                }
                value={guess}
                disabled={Boolean(roundResult)}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                onKeyDown={handleKeyDown}
                onChange={(e) => {
                  setGuess(e.target.value)
                  setHighlightedIndex(0)
                  setShowDropdown(true)
                }}
              />
            </div>

            <div className="controls-buttons">
              {!roundResult ? (
                <>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={gameCategory === 'snake' && !currentSnakeData}
                  >
                    Submit Guess
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={gameCategory === 'snake' && !currentSnakeData}
                    onClick={() => {
                      setHideRevealBanner(false)
                      setRoundResult({ correct: false })
                      setShowDropdown(false)
                    }}
                  >
                    Skip
                  </button>
                </>
              ) : (
                <button type="button" className="primary-button" onClick={nextRound}>
                  {currentIndex + 1 >= sessionQueue.length
                    ? 'Finish Expedition →'
                    : gameCategory === 'bird'
                    ? 'Next Bird →'
                    : 'Next Snake →'}
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {screen === 'summary' && (
        <>
          <div className="start-header">
            <h2 className="start-title">Expedition Complete</h2>
            <p className="start-subtitle">Final Field Report</p>
          </div>

          <div style={{ margin: 'auto 0' }}>
            <div
              style={{
                fontSize: '2.5rem',
                fontWeight: 900,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              {score} / {sessionQueue.length}
            </div>
            <p style={{ marginTop: '0.5rem', color: '#334155', fontWeight: 600 }}>
              {Math.round((score / Math.max(sessionQueue.length, 1)) * 100)}% Accuracy
            </p>
          </div>

          <div className="card-footer">
            <button
              type="button"
              className="primary-button"
              onClick={handleBack}
            >
              Back to Settings
            </button>
          </div>
        </>
      )}
    </main>
  )
}

export default App