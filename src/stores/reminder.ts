import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type TaskZone = 'deadline' | 'open'
export type CacheReason = 'expired' | 'done' | 'dismissed'

export interface Task {
  id: string
  title: string
  notes: string
  zone: TaskZone
  deadlineAt: number | null
  createdAt: number
  updatedAt: number
  status: 'active' | 'cached'
  cachedAt: number | null
  cacheReason: CacheReason | null
  recurrenceRuleId: string | null
  occurrenceKey: string | null
}

export interface RecurringRule {
  id: string
  title: string
  notes: string
  weekday: number
  hour: number
  minute: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ReminderSettings {
  panelBackground: string
  panelText: string
  panelAccent: string
  panelCard: string
  fontScale: number
  panelOpacity: number
  panelRadius: number
}

interface RecurrenceHistoryEntry {
  occurrenceKey: string
  deadlineAt: number
}

interface ReminderSnapshot {
  tasks: Task[]
  recurringRules: RecurringRule[]
  recurrenceHistory: RecurrenceHistoryEntry[]
  settings: ReminderSettings
}

const STORAGE_KEY = 'desktop-reminder-state'
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_RETENTION_MS = ONE_DAY_MS * 120

const defaultSettings = (): ReminderSettings => ({
  panelBackground: '#172033',
  panelText: '#f8f3e8',
  panelAccent: '#ff9b71',
  panelCard: '#22314acc',
  fontScale: 1,
  panelOpacity: 0.88,
  panelRadius: 24,
})

const defaultSnapshot = (): ReminderSnapshot => ({
  tasks: [],
  recurringRules: [],
  recurrenceHistory: [],
  settings: defaultSettings(),
})

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const sortActiveTasks = (tasks: Task[]) =>
  [...tasks].sort((left, right) => {
    if (left.zone === 'deadline' && right.zone === 'deadline') {
      return (left.deadlineAt ?? Number.MAX_SAFE_INTEGER) - (right.deadlineAt ?? Number.MAX_SAFE_INTEGER)
    }

    if (left.zone !== right.zone) {
      return left.zone === 'deadline' ? -1 : 1
    }

    return right.updatedAt - left.updatedAt
  })

const getWeekStart = (source: Date) => {
  const start = new Date(source)
  start.setHours(0, 0, 0, 0)

  const mondayBasedDay = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - mondayBasedDay)
  return start
}

const getOccurrenceDeadline = (rule: RecurringRule, now: number) => {
  const weekStart = getWeekStart(new Date(now))
  const deadline = new Date(weekStart)
  deadline.setDate(weekStart.getDate() + (rule.weekday - 1))
  deadline.setHours(rule.hour, rule.minute, 0, 0)
  return deadline.getTime()
}

const isValidTask = (value: unknown): value is Task => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const task = value as Partial<Task>
  return typeof task.id === 'string' && typeof task.title === 'string' && typeof task.zone === 'string'
}

const isValidRule = (value: unknown): value is RecurringRule => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const rule = value as Partial<RecurringRule>
  return typeof rule.id === 'string' && typeof rule.title === 'string' && typeof rule.weekday === 'number'
}

export const useReminderStore = defineStore('reminder', () => {
  const tasks = ref<Task[]>([])
  const recurringRules = ref<RecurringRule[]>([])
  const recurrenceHistory = ref<RecurrenceHistoryEntry[]>([])
  const settings = ref<ReminderSettings>(defaultSettings())
  const currentTime = ref(Date.now())
  const initialized = ref(false)
  let timer: number | null = null
  let storageListenerBound = false

  const activeTasks = computed(() => sortActiveTasks(tasks.value.filter((task) => task.status === 'active')))
  const deadlineTasks = computed(() => activeTasks.value.filter((task) => task.zone === 'deadline'))
  const openTasks = computed(() => activeTasks.value.filter((task) => task.zone === 'open'))
  const cachedTasks = computed(() =>
    [...tasks.value]
      .filter((task) => task.status === 'cached')
      .sort((left, right) => (right.cachedAt ?? 0) - (left.cachedAt ?? 0)),
  )

  const persistSnapshot = () => {
    if (!initialized.value || typeof window === 'undefined') {
      return
    }

    const snapshot: ReminderSnapshot = {
      tasks: tasks.value,
      recurringRules: recurringRules.value,
      recurrenceHistory: recurrenceHistory.value,
      settings: settings.value,
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }

  const applySnapshot = (parsed: Partial<ReminderSnapshot>) => {
    const snapshot = defaultSnapshot()
    tasks.value = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValidTask) : snapshot.tasks
    recurringRules.value = Array.isArray(parsed.recurringRules)
      ? parsed.recurringRules.filter(isValidRule)
      : snapshot.recurringRules
    recurrenceHistory.value = Array.isArray(parsed.recurrenceHistory)
      ? parsed.recurrenceHistory.filter(
          (entry): entry is RecurrenceHistoryEntry =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof (entry as RecurrenceHistoryEntry).occurrenceKey === 'string' &&
            typeof (entry as RecurrenceHistoryEntry).deadlineAt === 'number',
        )
      : snapshot.recurrenceHistory
    settings.value = {
      ...snapshot.settings,
      ...(parsed.settings ?? {}),
    }
  }

  const hydrate = () => {
    if (typeof window === 'undefined') {
      return
    }

    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      initialized.value = true
      return
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ReminderSnapshot>
      applySnapshot(parsed)
    } catch {
      const snapshot = defaultSnapshot()
      applySnapshot(snapshot)
    }

    initialized.value = true
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) {
      return
    }

    try {
      applySnapshot(JSON.parse(event.newValue) as Partial<ReminderSnapshot>)
      syncTime()
    } catch {
      hydrate()
      syncTime()
    }
  }

  const pruneRecurrenceHistory = (now = Date.now()) => {
    recurrenceHistory.value = recurrenceHistory.value.filter((entry) => entry.deadlineAt >= now - HISTORY_RETENTION_MS)
  }

  const materializeRecurringTasks = (now = Date.now()) => {
    const knownOccurrences = new Set(recurrenceHistory.value.map((entry) => entry.occurrenceKey))
    const newTasks: Task[] = []
    const newHistoryEntries: RecurrenceHistoryEntry[] = []

    recurringRules.value
      .filter((rule) => rule.enabled)
      .forEach((rule) => {
        const deadlineAt = getOccurrenceDeadline(rule, now)
        const occurrenceKey = `${rule.id}:${deadlineAt}`

        if (knownOccurrences.has(occurrenceKey)) {
          return
        }

        const timestamp = Date.now()
        newTasks.push({
          id: createId(),
          title: rule.title,
          notes: rule.notes,
          zone: 'deadline',
          deadlineAt,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: 'active',
          cachedAt: null,
          cacheReason: null,
          recurrenceRuleId: rule.id,
          occurrenceKey,
        })
        newHistoryEntries.push({ occurrenceKey, deadlineAt })
        knownOccurrences.add(occurrenceKey)
      })

    if (newTasks.length > 0) {
      tasks.value = [...tasks.value, ...newTasks]
      recurrenceHistory.value = [...recurrenceHistory.value, ...newHistoryEntries]
    }
  }

  const archiveExpiredTasks = (now = Date.now()) => {
    let changed = false

    tasks.value = tasks.value.map((task) => {
      if (task.status !== 'active' || task.zone !== 'deadline' || task.deadlineAt === null || task.deadlineAt > now) {
        return task
      }

      changed = true
      return {
        ...task,
        status: 'cached',
        cachedAt: now,
        cacheReason: 'expired',
        updatedAt: now,
      }
    })

    return changed
  }

  const purgeCache = (now = Date.now()) => {
    tasks.value = tasks.value.filter(
      (task) => task.status !== 'cached' || task.cachedAt === null || now - task.cachedAt < ONE_DAY_MS,
    )
  }

  const syncTime = (now = Date.now()) => {
    currentTime.value = now
    materializeRecurringTasks(now)
    archiveExpiredTasks(now)
    purgeCache(now)
    pruneRecurrenceHistory(now)
  }

  const initialize = () => {
    if (!initialized.value) {
      hydrate()
    }

    syncTime()

    if (timer !== null || typeof window === 'undefined') {
      return
    }

    if (!storageListenerBound) {
      window.addEventListener('storage', handleStorageChange)
      storageListenerBound = true
    }

    timer = window.setInterval(() => {
      syncTime()
    }, 30_000)
  }

  const stopClock = () => {
    if (timer !== null && typeof window !== 'undefined') {
      window.clearInterval(timer)
      timer = null
    }

    if (storageListenerBound && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorageChange)
      storageListenerBound = false
    }
  }

  const addTask = (input: { title: string; notes: string; zone: TaskZone; deadlineAt: number | null }) => {
    const timestamp = Date.now()
    const task: Task = {
      id: createId(),
      title: input.title.trim(),
      notes: input.notes.trim(),
      zone: input.zone,
      deadlineAt: input.zone === 'deadline' ? input.deadlineAt : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'active',
      cachedAt: null,
      cacheReason: null,
      recurrenceRuleId: null,
      occurrenceKey: null,
    }

    tasks.value = [task, ...tasks.value]
    syncTime()
  }

  const updateTask = (taskId: string, input: { title: string; notes: string; zone: TaskZone; deadlineAt: number | null }) => {
    const timestamp = Date.now()
    tasks.value = tasks.value.map((task) =>
      task.id === taskId
        ? {
            ...task,
            title: input.title.trim(),
            notes: input.notes.trim(),
            zone: input.zone,
            deadlineAt: input.zone === 'deadline' ? input.deadlineAt : null,
            updatedAt: timestamp,
          }
        : task,
    )
    syncTime()
  }

  const moveTaskToCache = (taskId: string, reason: CacheReason) => {
    const timestamp = Date.now()
    tasks.value = tasks.value.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'cached',
            cachedAt: timestamp,
            cacheReason: reason,
            updatedAt: timestamp,
          }
        : task,
    )
  }

  const restoreTask = (taskId: string) => {
    const timestamp = Date.now()
    tasks.value = tasks.value.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: 'active',
            cachedAt: null,
            cacheReason: null,
            updatedAt: timestamp,
          }
        : task,
    )
    syncTime()
  }

  const deleteTaskPermanently = (taskId: string) => {
    tasks.value = tasks.value.filter((task) => task.id !== taskId)
  }

  const saveRecurringRule = (input: {
    id?: string
    title: string
    notes: string
    weekday: number
    hour: number
    minute: number
    enabled: boolean
  }) => {
    const timestamp = Date.now()

    if (input.id) {
      recurringRules.value = recurringRules.value.map((rule) =>
        rule.id === input.id
          ? {
              ...rule,
              title: input.title.trim(),
              notes: input.notes.trim(),
              weekday: input.weekday,
              hour: input.hour,
              minute: input.minute,
              enabled: input.enabled,
              updatedAt: timestamp,
            }
          : rule,
      )
    } else {
      recurringRules.value = [
        {
          id: createId(),
          title: input.title.trim(),
          notes: input.notes.trim(),
          weekday: input.weekday,
          hour: input.hour,
          minute: input.minute,
          enabled: input.enabled,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        ...recurringRules.value,
      ]
    }

    syncTime()
  }

  const toggleRecurringRule = (ruleId: string) => {
    recurringRules.value = recurringRules.value.map((rule) =>
      rule.id === ruleId
        ? {
            ...rule,
            enabled: !rule.enabled,
            updatedAt: Date.now(),
          }
        : rule,
    )
    syncTime()
  }

  const deleteRecurringRule = (ruleId: string) => {
    recurringRules.value = recurringRules.value.filter((rule) => rule.id !== ruleId)
  }

  watch([tasks, recurringRules, recurrenceHistory, settings], persistSnapshot, { deep: true })

  return {
    tasks,
    recurringRules,
    settings,
    currentTime,
    activeTasks,
    deadlineTasks,
    openTasks,
    cachedTasks,
    initialize,
    stopClock,
    syncTime,
    addTask,
    updateTask,
    moveTaskToCache,
    restoreTask,
    deleteTaskPermanently,
    saveRecurringRule,
    toggleRecurringRule,
    deleteRecurringRule,
  }
})
