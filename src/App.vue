<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { isTauri as checkIsTauri } from '@tauri-apps/api/core'
import { LogicalSize, Window, getCurrentWindow } from '@tauri-apps/api/window'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { StateFlags, saveWindowState } from '@tauri-apps/plugin-window-state'

import { type CacheReason, type RecurringRule, type Task, type TaskZone, useReminderStore } from './stores/reminder'

const reminderStore = useReminderStore()

const isTauri = checkIsTauri()
const viewParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null
const isFloatingView = viewParam === 'floating'

const weekOptions = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
]

const hourOptions = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'))
const minuteOptions = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))

const taskForm = reactive({
  id: '',
  title: '',
  notes: '',
  zone: 'deadline' as TaskZone,
  deadlineDate: '',
  deadlineHour: '11',
  deadlineMinute: '00',
})

const recurringForm = reactive({
  id: '',
  title: '',
  notes: '',
  weekday: 5,
  hour: 11,
  minute: 0,
  enabled: true,
})

const editorTab = ref<'tasks' | 'recurring' | 'settings' | 'cache'>('tasks')
const autostartEnabled = ref(false)
const autostartBusy = ref(false)
const currentWindowLabel = ref<string | null>(null)
const windowUnlistenFns: Array<() => void> = []
const floatingShellRef = ref<HTMLElement | null>(null)

const panelStyle = computed(() => ({
  '--panel-bg': reminderStore.settings.panelBackground,
  '--panel-text': reminderStore.settings.panelText,
  '--panel-accent': reminderStore.settings.panelAccent,
  '--panel-card': reminderStore.settings.panelCard,
  '--panel-opacity': String(reminderStore.settings.panelOpacity),
  '--panel-radius': `${reminderStore.settings.panelRadius}px`,
  '--font-scale': String(reminderStore.settings.fontScale),
}))

const previewClock = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(reminderStore.currentTime),
)

const taskFormTitle = computed(() => (taskForm.id ? 'Edit Task' : 'Add Task'))
const recurringFormTitle = computed(() => (recurringForm.id ? 'Edit Weekly Rule' : 'Add Weekly Rule'))
const taskSubmitLabel = computed(() => (taskForm.id ? 'Update task' : 'Create task'))
const recurringSubmitLabel = computed(() => (recurringForm.id ? 'Update weekly rule' : 'Create weekly rule'))
const activeTaskCount = computed(() => reminderStore.deadlineTasks.length + reminderStore.openTasks.length)
const visibleDeadlineTasks = computed(() => reminderStore.deadlineTasks.slice(0, 5))
const hiddenDeadlineCount = computed(() => Math.max(reminderStore.deadlineTasks.length - visibleDeadlineTasks.value.length, 0))

const autostartSummary = computed(() => {
  if (!isTauri) {
    return '浏览器模式下不会注册开机启动。'
  }
  return autostartEnabled.value
    ? '已启用开机启动。系统登录后会自动恢复悬浮窗。'
    : '当前未启用开机启动。'
})

const taskCanSubmit = computed(() => {
  if (!taskForm.title.trim()) {
    return false
  }
  if (taskForm.zone === 'deadline' && !taskForm.deadlineDate) {
    return false
  }
  return true
})

const recurringCanSubmit = computed(() => recurringForm.title.trim().length > 0)

const buildDeadlineTimestamp = () => {
  if (!taskForm.deadlineDate) {
    return null
  }
  const date = new Date(`${taskForm.deadlineDate}T${taskForm.deadlineHour}:${taskForm.deadlineMinute}:00`)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

const hydrateDeadlineForm = (timestamp: number | null) => {
  if (timestamp === null) {
    taskForm.deadlineDate = ''
    taskForm.deadlineHour = '11'
    taskForm.deadlineMinute = '00'
    return
  }
  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60_000)
  const [datePart, timePart] = local.toISOString().slice(0, 16).split('T')
  taskForm.deadlineDate = datePart ?? ''
  taskForm.deadlineHour = timePart?.slice(0, 2) ?? '11'
  taskForm.deadlineMinute = timePart?.slice(3, 5) ?? '00'
}

const formatAbsoluteTime = (timestamp: number | null) => {
  if (timestamp === null) {
    return 'No deadline'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

const formatRemaining = (timestamp: number | null) => {
  if (timestamp === null) {
    return 'No deadline'
  }
  const diff = timestamp - reminderStore.currentTime
  if (diff <= 0) {
    return 'Expired'
  }
  const totalMinutes = Math.floor(diff / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    return `${days}d ${hours}h left`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m left`
  }
  return `${minutes}m left`
}

const formatCacheReason = (reason: CacheReason | null) => {
  if (reason === 'expired') {
    return 'Expired and archived'
  }
  if (reason === 'done') {
    return 'Completed and archived'
  }
  if (reason === 'dismissed') {
    return 'Dismissed manually'
  }
  return 'Archived'
}

const formatRuleTime = (rule: RecurringRule) => {
  const day = weekOptions.find((item) => item.value === rule.weekday)?.label ?? 'Unknown'
  const hour = String(rule.hour).padStart(2, '0')
  const minute = String(rule.minute).padStart(2, '0')
  return `${day} ${hour}:${minute}`
}

const resetTaskForm = () => {
  taskForm.id = ''
  taskForm.title = ''
  taskForm.notes = ''
  taskForm.zone = 'deadline'
  taskForm.deadlineDate = ''
  taskForm.deadlineHour = '11'
  taskForm.deadlineMinute = '00'
}

const resetRecurringForm = () => {
  recurringForm.id = ''
  recurringForm.title = ''
  recurringForm.notes = ''
  recurringForm.weekday = 5
  recurringForm.hour = 11
  recurringForm.minute = 0
  recurringForm.enabled = true
}

const persistFloatingWindowState = async () => {
  if (!isTauri || currentWindowLabel.value !== 'floating') {
    return
  }
  await saveWindowState(StateFlags.POSITION | StateFlags.SIZE | StateFlags.VISIBLE)
}

// 悬浮窗内容高度自适应实现
const syncFloatingWindowSize = async () => {
  if (!(isTauri && currentWindowLabel.value === 'floating')) return
  await nextTick()
  if (!floatingShellRef.value) return
  const windowChromeHeight = 56
  const contentHeight = floatingShellRef.value.scrollHeight + windowChromeHeight
  const minHeight = 280, maxHeight = 620
  let targetHeight = Math.ceil(contentHeight)
  targetHeight = Math.max(minHeight, Math.min(maxHeight, targetHeight))
  await getCurrentWindow().setSize(new LogicalSize(388, targetHeight))
}

const startFloatingDrag = async (event: MouseEvent) => {
  if (!(isTauri && currentWindowLabel.value === 'floating') || event.button !== 0) {
    return
  }

  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, textarea, select, option, a')) {
    return
  }

  try {
    event.preventDefault()
    await getCurrentWindow().startDragging()
  } catch (error) {
    console.error('Failed to start floating drag', error)
  }
}

watch(
  [
    () => reminderStore.deadlineTasks.length,
    () => reminderStore.openTasks.length,
    () => reminderStore.settings.fontScale,
  ],
  () => { void syncFloatingWindowSize() }
)


const startTaskEdit = async (task: Task) => {
  if (isFloatingView) {
    await openEditorWindow()
  }
  editorTab.value = 'tasks'
  taskForm.id = task.id
  taskForm.title = task.title
  taskForm.notes = task.notes
  taskForm.zone = task.zone
  hydrateDeadlineForm(task.deadlineAt)
}

const startRecurringEdit = (rule: RecurringRule) => {
  editorTab.value = 'recurring'
  recurringForm.id = rule.id
  recurringForm.title = rule.title
  recurringForm.notes = rule.notes
  recurringForm.weekday = rule.weekday
  recurringForm.hour = rule.hour
  recurringForm.minute = rule.minute
  recurringForm.enabled = rule.enabled
}

const submitTask = () => {
  if (!taskCanSubmit.value) {
    return
  }
  const payload = {
    title: taskForm.title,
    notes: taskForm.notes,
    zone: taskForm.zone,
    deadlineAt: taskForm.zone === 'deadline' ? buildDeadlineTimestamp() : null,
  }
  if (taskForm.id) {
    reminderStore.updateTask(taskForm.id, payload)
  } else {
    reminderStore.addTask(payload)
  }
  resetTaskForm()
}

const submitRecurring = () => {
  if (!recurringCanSubmit.value) {
    return
  }
  reminderStore.saveRecurringRule({
    id: recurringForm.id || undefined,
    title: recurringForm.title,
    notes: recurringForm.notes,
    weekday: recurringForm.weekday,
    hour: recurringForm.hour,
    minute: recurringForm.minute,
    enabled: recurringForm.enabled,
  })
  resetRecurringForm()
}

const openEditorWindow = async () => {
  if (!isTauri) {
    return
  }
  try {
    const editorWindow = await Window.getByLabel('editor')
    if (!editorWindow) {
      console.warn('Editor window not found')
      return
    }

    await editorWindow.show()
    await editorWindow.unminimize()
    await editorWindow.setFocus()
  } catch (error) {
    console.error('Failed to open editor window', error)
  }
}

const openFloatingWindow = async () => {
  if (!isTauri) {
    return
  }
  try {
    const floatingWindow = await Window.getByLabel('floating')
    if (!floatingWindow) {
      console.warn('Floating window not found')
      return
    }

    await floatingWindow.show()
    await floatingWindow.unminimize()
  } catch (error) {
    console.error('Failed to open floating window', error)
  }
}

const hideCurrentWindow = async () => {
  if (!isTauri) {
    return
  }
  try {
    await getCurrentWindow().hide()
  } catch (error) {
    console.error('Failed to hide current window', error)
  }
}

const syncAutostartState = async () => {
  if (!isTauri) {
    autostartEnabled.value = false
    return
  }
  autostartEnabled.value = await isEnabled()
}

const toggleAutostart = async () => {
  if (!isTauri || autostartBusy.value) {
    return
  }
  autostartBusy.value = true
  try {
    if (autostartEnabled.value) {
      await disable()
      autostartEnabled.value = false
    } else {
      await enable()
      autostartEnabled.value = true
    }
  } finally {
    autostartBusy.value = false
  }
}

const bindFloatingWindowPersistence = async () => {
  if (!isTauri || currentWindowLabel.value !== 'floating') {
    return
  }
  const appWindow = getCurrentWindow()
  windowUnlistenFns.push(await appWindow.onMoved(() => void persistFloatingWindowState()))
  windowUnlistenFns.push(await appWindow.onResized(() => void persistFloatingWindowState()))
}

onMounted(async () => {
  document.body.classList.toggle('is-floating-window', isFloatingView)
  reminderStore.initialize()

  if (!isTauri) {
    return
  }

  currentWindowLabel.value = getCurrentWindow().label
  await syncAutostartState()
  await bindFloatingWindowPersistence()
  await syncFloatingWindowSize()
})

onBeforeUnmount(() => {
  document.body.classList.remove('is-floating-window')
  reminderStore.stopClock()
  windowUnlistenFns.splice(0).forEach((unlisten) => unlisten())
})
</script>

<template>
  <div :class="['app-shell', { floating: isFloatingView }]" :style="panelStyle">
    <template v-if="isFloatingView">
      <main ref="floatingShellRef" class="floating-shell">
        <header class="floating-topbar">
          <div class="floating-drag-zone" @mousedown="startFloatingDrag">
            <p class="floating-label">Desktop Reminder</p>
            <h1>{{ previewClock }}</h1>
          </div>
          <div class="topbar-actions">
            <button class="mini-button secondary" type="button" @mousedown.stop @click.stop="openEditorWindow">Edit</button>
            <button class="mini-button secondary" type="button" @mousedown.stop @click.stop="hideCurrentWindow">Hide</button>
          </div>
        </header>

        <section class="floating-section">
          <div class="section-heading">
            <h2>With DDL</h2>
            <span>{{ reminderStore.deadlineTasks.length }}</span>
          </div>

          <div v-if="reminderStore.deadlineTasks.length === 0" class="empty-card">暂时没有带截止时间的事项</div>

          <article v-for="task in visibleDeadlineTasks" :key="task.id" class="floating-card urgent">
            <div class="card-copy" @click="startTaskEdit(task)">
              <strong>{{ task.title }}</strong>
              <p>{{ formatAbsoluteTime(task.deadlineAt) }}</p>
              <small>{{ formatRemaining(task.deadlineAt) }}</small>
            </div>
            <button class="mini-button" type="button" @click="reminderStore.moveTaskToCache(task.id, 'done')">Done</button>
          </article>

          <div v-if="hiddenDeadlineCount > 0" class="floating-overflow-note">
            还有 {{ hiddenDeadlineCount }} 条更晚截止的任务未显示
          </div>
        </section>

        <section class="floating-section">
          <div class="section-heading">
            <h2>No DDL</h2>
            <span>{{ reminderStore.openTasks.length }}</span>
          </div>

          <div v-if="reminderStore.openTasks.length === 0" class="empty-card">暂时没有无截止时间的事项</div>

          <article v-for="task in reminderStore.openTasks" :key="task.id" class="floating-card">
            <div class="card-copy" @click="startTaskEdit(task)">
              <strong>{{ task.title }}</strong>
              <p>{{ task.notes || '点击编辑窗口补充备注' }}</p>
            </div>
            <button class="mini-button secondary" type="button" @click="reminderStore.moveTaskToCache(task.id, 'done')">Hide</button>
          </article>
        </section>
      </main>
    </template>

    <template v-else>
      <main class="editor-shell">
        <section class="hero-panel">
          <div class="hero-copy">
            <p class="eyebrow">Desktop App Editor</p>
            <h1>Floating Todo Control Center</h1>
            <p class="hero-text">
              这里负责新增事项、编辑每周重复规则和调整悬浮窗样式。关闭编辑窗口后，应用会继续在系统托盘中运行。
            </p>
          </div>

          <div class="hero-metrics">
            <div class="metric-card">
              <span>Active</span>
              <strong>{{ activeTaskCount }}</strong>
            </div>
            <div class="metric-card">
              <span>Recurring</span>
              <strong>{{ reminderStore.recurringRules.length }}</strong>
            </div>
            <div class="metric-card">
              <span>Cached</span>
              <strong>{{ reminderStore.cachedTasks.length }}</strong>
            </div>
          </div>
        </section>

        <section class="editor-panel">
          <div class="tab-row">
            <button :class="['tab-button', { active: editorTab === 'tasks' }]" type="button" @click="editorTab = 'tasks'">Tasks</button>
            <button :class="['tab-button', { active: editorTab === 'recurring' }]" type="button" @click="editorTab = 'recurring'">Weekly</button>
            <button :class="['tab-button', { active: editorTab === 'settings' }]" type="button" @click="editorTab = 'settings'">Style</button>
            <button :class="['tab-button', { active: editorTab === 'cache' }]" type="button" @click="editorTab = 'cache'">Cache</button>
          </div>

          <div v-if="editorTab === 'tasks'" class="editor-card">
            <div class="card-head">
              <div>
                <p class="eyebrow">Task Editor</p>
                <h2>{{ taskFormTitle }}</h2>
              </div>
              <button class="ghost-button" type="button" @click="resetTaskForm">Reset</button>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>Title</span>
                <input v-model="taskForm.title" type="text" placeholder="例如：完成微积分作业" />
              </label>

              <label class="field">
                <span>Zone</span>
                <select v-model="taskForm.zone">
                  <option value="deadline">With DDL</option>
                  <option value="open">No DDL</option>
                </select>
              </label>

              <label class="field field-wide">
                <span>Notes</span>
                <textarea v-model="taskForm.notes" rows="4" placeholder="补充说明、课程名、文件位置等"></textarea>
              </label>

              <div v-if="taskForm.zone === 'deadline'" class="field field-wide">
                <span>Deadline</span>
                <div class="deadline-picker">
                  <input v-model="taskForm.deadlineDate" class="date-input" type="date" />
                  <select v-model="taskForm.deadlineHour" class="time-select">
                    <option v-for="hour in hourOptions" :key="hour" :value="hour">{{ hour }}</option>
                  </select>
                  <span class="time-separator">:</span>
                  <select v-model="taskForm.deadlineMinute" class="time-select">
                    <option v-for="minute in minuteOptions" :key="minute" :value="minute">{{ minute }}</option>
                  </select>
                </div>
              </div>
            </div>

            <div class="action-row">
              <button class="primary-button" type="button" :disabled="!taskCanSubmit" @click="submitTask">
                {{ taskSubmitLabel }}
              </button>
            </div>

            <div class="list-section">
              <div class="list-head">
                <h3>All Active Tasks</h3>
                <span>{{ activeTaskCount }}</span>
              </div>

              <article v-for="task in reminderStore.activeTasks" :key="task.id" class="task-row">
                <div class="row-copy" @click="startTaskEdit(task)">
                  <strong>{{ task.title }}</strong>
                  <p>{{ task.zone === 'deadline' ? formatAbsoluteTime(task.deadlineAt) : 'No deadline' }}</p>
                </div>
                <div class="row-actions">
                  <button class="mini-button secondary" type="button" @click="startTaskEdit(task)">Edit</button>
                  <button class="mini-button" type="button" @click="reminderStore.moveTaskToCache(task.id, 'done')">Done</button>
                </div>
              </article>
            </div>
          </div>

          <div v-else-if="editorTab === 'recurring'" class="editor-card">
            <div class="card-head">
              <div>
                <p class="eyebrow">Weekly Rules</p>
                <h2>{{ recurringFormTitle }}</h2>
              </div>
              <button class="ghost-button" type="button" @click="resetRecurringForm">Reset</button>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>Title</span>
                <input v-model="recurringForm.title" type="text" placeholder="例如：每周五前提交微积分作业" />
              </label>

              <label class="field">
                <span>Weekday</span>
                <select v-model="recurringForm.weekday">
                  <option v-for="option in weekOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>Hour</span>
                <input v-model.number="recurringForm.hour" type="number" min="0" max="23" />
              </label>

              <label class="field">
                <span>Minute</span>
                <input v-model.number="recurringForm.minute" type="number" min="0" max="59" />
              </label>

              <label class="field field-wide">
                <span>Notes</span>
                <textarea v-model="recurringForm.notes" rows="4" placeholder="这条规则会每周自动生成一次带 DDL 的事项"></textarea>
              </label>

              <label class="toggle-field">
                <input v-model="recurringForm.enabled" type="checkbox" />
                <span>Rule enabled</span>
              </label>
            </div>

            <div class="action-row">
              <button class="primary-button" type="button" :disabled="!recurringCanSubmit" @click="submitRecurring">
                {{ recurringSubmitLabel }}
              </button>
            </div>

            <div class="list-section">
              <div class="list-head">
                <h3>Saved Weekly Rules</h3>
                <span>{{ reminderStore.recurringRules.length }}</span>
              </div>

              <article v-for="rule in reminderStore.recurringRules" :key="rule.id" class="task-row">
                <div class="row-copy" @click="startRecurringEdit(rule)">
                  <strong>{{ rule.title }}</strong>
                  <p>{{ formatRuleTime(rule) }}</p>
                </div>
                <div class="row-actions">
                  <button class="mini-button secondary" type="button" @click="reminderStore.toggleRecurringRule(rule.id)">
                    {{ rule.enabled ? 'Pause' : 'Enable' }}
                  </button>
                  <button class="mini-button" type="button" @click="startRecurringEdit(rule)">Edit</button>
                </div>
              </article>
            </div>
          </div>

          <div v-else-if="editorTab === 'settings'" class="editor-card">
            <div class="card-head">
              <div>
                <p class="eyebrow">Panel Style</p>
                <h2>Customize Floating Window</h2>
              </div>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>Background</span>
                <input v-model="reminderStore.settings.panelBackground" type="color" />
              </label>

              <label class="field">
                <span>Text Color</span>
                <input v-model="reminderStore.settings.panelText" type="color" />
              </label>

              <label class="field">
                <span>Accent</span>
                <input v-model="reminderStore.settings.panelAccent" type="color" />
              </label>

              <label class="field">
                <span>Card Color</span>
                <input v-model="reminderStore.settings.panelCard" type="color" />
              </label>

              <label class="field">
                <span>Font Scale</span>
                <input v-model.number="reminderStore.settings.fontScale" type="range" min="0.85" max="1.4" step="0.05" />
              </label>

              <label class="field">
                <span>Opacity</span>
                <input v-model.number="reminderStore.settings.panelOpacity" type="range" min="0.4" max="1" step="0.05" />
              </label>

              <label class="field">
                <span>Radius</span>
                <input v-model.number="reminderStore.settings.panelRadius" type="range" min="12" max="36" step="1" />
              </label>
            </div>

            <div class="settings-note">
              <div class="settings-switch">
                <div>
                  <strong>Start with Windows</strong>
                  <p>{{ autostartSummary }}</p>
                </div>
                <button class="primary-button" type="button" :disabled="autostartBusy || !isTauri" @click="toggleAutostart">
                  {{ autostartEnabled ? 'Disable' : 'Enable' }}
                </button>
              </div>

              <div class="settings-switch">
                <div>
                  <strong>System tray mode</strong>
                  <p>关闭编辑窗口后应用不会退出，而是缩到系统托盘。再次启动应用时会唤醒旧窗口，而不是创建新的悬浮窗。</p>
                </div>
                <button class="ghost-button" type="button" @click="openEditorWindow">
                  Open editor
                </button>
              </div>

              <div class="settings-switch">
                <div>
                  <strong>Remember floating position</strong>
                  <p>悬浮窗拖动或缩放后会自动记住位置和尺寸，下次启动时恢复。</p>
                </div>
                <button class="ghost-button" type="button" @click="persistFloatingWindowState">
                  Save now
                </button>
              </div>

              <div class="settings-switch">
                <div>
                  <strong>Open floating window</strong>
                  <p>如果悬浮窗被隐藏了，可以在这里快速重新显示。</p>
                </div>
                <button class="ghost-button" type="button" @click="openFloatingWindow">
                  Show floating
                </button>
              </div>
            </div>
          </div>

          <div v-else class="editor-card">
            <div class="card-head">
              <div>
                <p class="eyebrow">Archive Buffer</p>
                <h2>Cached Tasks</h2>
              </div>
            </div>

            <p class="hero-text compact">缓存区会保留 24 小时，超时后自动删除。</p>

            <article v-for="task in reminderStore.cachedTasks" :key="task.id" class="task-row">
              <div class="row-copy">
                <strong>{{ task.title }}</strong>
                <p>{{ formatCacheReason(task.cacheReason) }}</p>
              </div>
              <div class="row-actions">
                <button class="mini-button secondary" type="button" @click="reminderStore.restoreTask(task.id)">Restore</button>
                <button class="mini-button" type="button" @click="reminderStore.deleteTaskPermanently(task.id)">Delete</button>
              </div>
            </article>

            <div v-if="reminderStore.cachedTasks.length === 0" class="empty-card editor-empty">当前缓存区为空</div>
          </div>
        </section>
      </main>
    </template>
  </div>
</template>

<style scoped>
:global(body) {
  margin: 0;
  min-width: 320px;
  background:
    radial-gradient(circle at top left, rgba(255, 184, 108, 0.24), transparent 28%),
    radial-gradient(circle at bottom right, rgba(88, 120, 255, 0.18), transparent 24%),
    #0d1320;
  color: #f5efe4;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

:global(body.is-floating-window) {
  background: transparent;
  overflow: hidden;
}

:global(*) {
  box-sizing: border-box;
}

.app-shell {
  min-height: 100vh;
  color: #f5efe4;
}

.app-shell.floating {
  min-height: auto;
  width: 100%;
  padding: 0;
  background: transparent;
  overflow: hidden;
}

.floating-shell {
  width: 100%;
  max-width: 100%;
  min-height: 100%;
  padding: 16px;
  border-radius: var(--panel-radius);
  color: var(--panel-text);
  background: color-mix(in srgb, var(--panel-bg) calc(var(--panel-opacity) * 100%), transparent);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(20px);
  font-size: calc(1rem * var(--font-scale));
}

.floating-topbar,
.topbar-actions,
.section-heading,
.task-row,
.row-actions,
.card-head,
.list-head,
.tab-row,
.action-row,
.hero-metrics,
.settings-switch,
.deadline-picker {
  display: flex;
  align-items: center;
}

.floating-topbar,
.section-heading,
.task-row,
.card-head,
.list-head,
.action-row,
.settings-switch {
  justify-content: space-between;
}

.floating-topbar {
  gap: 16px;
  margin-bottom: 16px;
  align-items: flex-start;
  flex-wrap: nowrap;
}

.floating-drag-zone {
  flex: 1;
  min-width: 0;
  padding: 8px 0 10px;
  cursor: grab;
}

.floating-drag-zone:active {
  cursor: grabbing;
}

.floating-label,
.eyebrow {
  margin: 0 0 8px;
  font-size: 0.78rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #ffb891;
}

.floating-topbar h1,
.hero-copy h1,
.card-head h2 {
  margin: 0;
}

.floating-topbar h1 {
  font-size: 1.35rem;
}

.floating-section + .floating-section,
.list-section,
.settings-note {
  margin-top: 18px;
}

.section-heading {
  margin-bottom: 10px;
}

.section-heading h2,
.list-head h3 {
  margin: 0;
  font-size: 1rem;
}

.section-heading span,
.list-head span {
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 0.82rem;
}

.floating-card,
.task-row,
.empty-card,
.editor-card,
.metric-card,
.hero-panel {
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.floating-card,
.task-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px;
  background: var(--panel-card);
}

.floating-card + .floating-card,
.task-row + .task-row {
  margin-top: 10px;
}

.floating-overflow-note {
  margin-top: 10px;
  padding: 0 4px;
  font-size: 0.84rem;
  color: rgba(245, 239, 228, 0.62);
}

.floating-card.urgent {
  border-color: color-mix(in srgb, var(--panel-accent) 56%, transparent);
}

.card-copy,
.row-copy {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.card-copy strong,
.row-copy strong {
  display: block;
  font-size: 1rem;
}

.card-copy p,
.card-copy small,
.row-copy p,
.hero-text,
.settings-switch p {
  margin: 6px 0 0;
  line-height: 1.6;
  color: rgba(245, 239, 228, 0.74);
}

.editor-shell {
  min-height: 100vh;
  padding: 28px;
  display: grid;
  gap: 24px;
  background:
    linear-gradient(145deg, rgba(10, 18, 28, 0.96), rgba(17, 31, 48, 0.86)),
    linear-gradient(90deg, rgba(255, 155, 113, 0.08), transparent 40%);
}

.hero-panel {
  padding: 26px;
  background:
    linear-gradient(140deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02)),
    rgba(10, 16, 28, 0.56);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.24);
}

.hero-copy h1 {
  font-size: clamp(2rem, 5vw, 3rem);
}

.hero-metrics {
  gap: 14px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.metric-card {
  min-width: 120px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.04);
}

.metric-card span {
  display: block;
  color: rgba(245, 239, 228, 0.64);
}

.metric-card strong {
  display: block;
  margin-top: 8px;
  font-size: 1.8rem;
}

.editor-panel {
  display: grid;
  gap: 16px;
}

.tab-row {
  gap: 12px;
  flex-wrap: wrap;
}

.tab-button,
.primary-button,
.ghost-button,
.mini-button {
  border: 0;
  cursor: pointer;
  transition: transform 0.2s ease, opacity 0.2s ease, background 0.2s ease;
}

.tab-button {
  padding: 10px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #f5efe4;
}

.tab-button.active {
  margin-top: 5px;
  background: #ff9b71;
  color: #132134;
}

.editor-card {
  padding: 24px;
  background: rgba(14, 22, 34, 0.82);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.2);
}

.card-head {
  gap: 14px;
  margin-bottom: 20px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field,
.toggle-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-wide {
  grid-column: 1 / -1;
}

.field input,
.field select,
.field textarea,
.date-input,
.time-select {
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.05);
  color: #f5efe4;
}

.field input[type='color'] {
  min-height: 48px;
  padding: 6px;
}

.field input[type='range'] {
  padding-inline: 0;
}

.toggle-field {
  flex-direction: row;
  align-items: center;
  margin-top: 8px;
}

.deadline-picker {
  gap: 10px;
}

.date-input {
  flex: 1.8;
}

.time-select {
  flex: 1;
  appearance: none;
}

.time-separator {
  font-size: 1.1rem;
  color: rgba(245, 239, 228, 0.74);
}

.row-actions,
.topbar-actions {
  gap: 10px;
  flex-shrink: 0;
}

.primary-button,
.mini-button {
  padding: 10px 14px;
  border-radius: 12px;
  background: #ff9b71;
  color: #132134;
  font-weight: 700;
  margin-top: 15px;
}

.ghost-button,
.mini-button.secondary {
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  color: #f5efe4;
}

.primary-button:disabled,
.ghost-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.settings-note {
  display: grid;
  gap: 12px;
}

.settings-switch {
  gap: 16px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.settings-switch strong {
  display: block;
}

.empty-card {
  padding: 18px;
  text-align: center;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(245, 239, 228, 0.74);
}

.editor-empty {
  margin-top: 12px;
}

.compact {
  margin-bottom: 18px;
}

.tab-button:hover,
.primary-button:hover,
.ghost-button:hover,
.mini-button:hover {
  transform: translateY(-1px);
}

@media (max-width: 760px) {
  .editor-shell {
    padding: 18px;
  }

  .editor-card,
  .hero-panel {
    padding: 18px;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .task-row,
  .floating-card,
  .card-head,
  .settings-switch,
  .deadline-picker {
    flex-direction: column;
  }

  .row-actions,
  .topbar-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .date-input,
  .time-select {
    width: 100%;
  }
}
</style>
