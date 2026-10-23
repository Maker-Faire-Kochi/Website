<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAdminSupabase } from '../composables/useAdminSupabase'
import { getAdminSession, hasOwnerAccess } from '../composables/useAdminSession'
import {
  responsesToCsv,
  useInterestAnalytics,
} from '../composables/useInterestAnalytics'
import type { InterestResponseRow } from '~~/shared/interest/types'
import { PARTICIPATION, STATUSES } from '~~/shared/interest/constants'
import AdminBarChart from './AdminBarChart.vue'
import AdminDonut from './AdminDonut.vue'
import AdminHeatmap from './AdminHeatmap.vue'
import AdminLineChart from './AdminLineChart.vue'
import AdminPipeline from './AdminPipeline.vue'
import AdminSparkline from './AdminSparkline.vue'

const tab = ref<'summary' | 'responses'>('summary')
const rows = ref<InterestResponseRow[]>([])
const loading = ref(true)
const error = ref('')
const filterStatus = ref('')
const filterPart = ref('')
const search = ref('')
const openId = ref<string | null>(null)
const ownerOk = ref(false)
const email = ref('')
const copied = ref(false)

const {
  summary,
  participation,
  location,
  selfDescribe,
  heardFrom,
  projectCategories,
  volunteerAreas,
  weekCompare,
  series30,
  series14,
  heatmap,
  hasProject,
  volunteerTime,
  orgCollaborate,
  pipeline,
  combos,
  depth,
} = useInterestAnalytics(rows)

const range = ref<14 | 30>(30)
const trend = computed(() => (range.value === 30 ? series30.value : series14.value))
const spark = computed(() => series14.value.map((d) => d.count))
const sparkCum = computed(() => series14.value.map((d) => d.cumulative))

/** Participation counts per role, as 14-day daily series for the sparklines. */
function roleSpark(role: string) {
  const days = series14.value.map((d) => d.key)
  const idx = new Map(days.map((k, i) => [k, i]))
  const out = days.map(() => 0)
  for (const r of rows.value) {
    if (!r.participation.includes(role)) continue
    const d = new Date(r.created_at)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const i = idx.get(k)
    if (i !== undefined) out[i]! += 1
  }
  return out
}

const kpis = computed(() => [
  { l: 'Total responses', n: summary.value.total, spark: sparkCum.value, big: true },
  { l: 'Last 7 days', n: weekCompare.value.cur, delta: weekCompare.value.delta, spark: spark.value },
  { l: 'Today', n: summary.value.today },
  { l: 'Unreviewed', n: summary.value.newCount, alert: summary.value.newCount > 0 },
  { l: 'Exhibit intent', n: summary.value.exhibit, spark: roleSpark('exhibit') },
  { l: 'Volunteer', n: summary.value.volunteer, spark: roleSpark('volunteer') },
  { l: 'Workshop', n: summary.value.workshop, spark: roleSpark('workshop') },
  { l: 'Sponsor / partner', n: summary.value.sponsor, spark: roleSpark('sponsor') },
])

const gauges = computed(() => [
  { l: 'From Kerala', v: depth.value.local },
  { l: 'Reviewed', v: depth.value.reviewed },
  { l: 'Left a phone', v: depth.value.phone },
  { l: 'Described a project', v: depth.value.project },
  { l: 'In an organisation', v: depth.value.org },
])

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return rows.value.filter((r) => {
    if (filterStatus.value && r.status !== filterStatus.value) return false
    if (filterPart.value && !r.participation.includes(filterPart.value)) return false
    if (!q) return true
    return (
      r.name.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      (r.org_name || '').toLowerCase().includes(q)
    )
  })
})

const formUrl = computed(() => {
  if (import.meta.client) return `${window.location.origin}/interestform`
  return '/interestform'
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const supabase = useAdminSupabase()
    const { session, owner } = await getAdminSession()
    if (!session) {
      await navigateTo({ path: '/admin/login', query: { next: '/admin' } })
      return
    }
    email.value = session.user.email || ''
    ownerOk.value = owner
    if (!ownerOk.value) {
      await supabase.auth.signOut()
      await navigateTo({ path: '/admin/login', query: { reason: 'forbidden' } })
      return
    }
    rows.value = await fetchAllResponses(supabase)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    loading.value = false
  }
}

/** PostgREST caps one response at 1000 rows; page until a short page. */
async function fetchAllResponses(
  supabase: ReturnType<typeof useAdminSupabase>,
): Promise<InterestResponseRow[]> {
  const PAGE = 1000
  const all: InterestResponseRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error: qErr } = await supabase
      .from('interest_responses')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (qErr) throw qErr
    all.push(...((data || []) as InterestResponseRow[]))
    if (!data || data.length < PAGE) return all
  }
}

async function setStatus(id: string, status: string) {
  const supabase = useAdminSupabase()
  const { error: uErr } = await supabase
    .from('interest_responses')
    .update({ status })
    .eq('id', id)
  if (uErr) {
    error.value = uErr.message
    return
  }
  const row = rows.value.find((r) => r.id === id)
  if (row) row.status = status as InterestResponseRow['status']
}

async function signOut() {
  const supabase = useAdminSupabase()
  await supabase.auth.signOut()
  await navigateTo({ path: '/admin/login', query: { reason: 'signedout' } })
}

async function copyFormLink() {
  try {
    await navigator.clipboard.writeText(formUrl.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    error.value = 'Could not copy link'
  }
}

function downloadCsv() {
  const csv = responsesToCsv(filtered.value)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `interest-responses-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function partLabel(values: string[]) {
  return values
    .map((v) => PARTICIPATION.find((p) => p.value === v)?.label || v)
    .join(', ')
}

onMounted(() => {
  load()
  const supabase = useAdminSupabase()
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      navigateTo({ path: '/admin/login', query: { reason: 'signedout' } })
      return
    }
    void hasOwnerAccess(session.access_token).then((owner) => {
      if (!owner) {
        return supabase.auth.signOut().then(() =>
          navigateTo({ path: '/admin/login', query: { reason: 'forbidden' } }),
        )
      }
    })
  })
  onUnmounted(() => {
    sub.subscription.unsubscribe()
  })
})
</script>

<template>
  <div class="panel">
    <header class="dash-head">
      <div>
        <p class="eyebrow">Sht 00 &middot; Interest form</p>
        <h1 class="dash-title">Control room</h1>
        <p v-if="email && ownerOk" class="signed-in">
          <span class="live-dot" aria-hidden="true" />Signed in as {{ email }}
        </p>
      </div>
      <div class="dash-actions">
        <a class="key" :href="formUrl" target="_blank" rel="noopener">Open form</a>
        <button type="button" class="key" @click="copyFormLink">
          {{ copied ? 'Copied' : 'Copy link' }}
        </button>
        <button type="button" class="key" @click="load">Refresh</button>
        <button type="button" class="key" @click="signOut">Sign out</button>
      </div>
    </header>

    <div v-if="loading" class="state" role="status">
      <span class="state-bar" aria-hidden="true" />
      Loading responses
    </div>
    <p v-else-if="error" class="state err" role="alert">{{ error }}</p>

    <template v-else-if="ownerOk">
      <div class="tabs" role="tablist" aria-label="Admin views">
        <button
          type="button"
          role="tab"
          class="a-tab"
          :class="{ active: tab === 'summary' }"
          :aria-selected="tab === 'summary'"
          @click="tab = 'summary'"
        >
          01 Summary
        </button>
        <button
          type="button"
          role="tab"
          class="a-tab"
          :class="{ active: tab === 'responses' }"
          :aria-selected="tab === 'responses'"
          @click="tab = 'responses'"
        >
          02 Responses
          <span class="badge">{{ summary.total }}</span>
        </button>
      </div>

      <!-- SUMMARY -->
      <div v-show="tab === 'summary'" class="summary">
        <dl class="kpi-grid">
          <div
            v-for="k in kpis"
            :key="k.l"
            class="kpi"
            :class="{ 'kpi-big': k.big, 'kpi-alert': k.alert }"
          >
            <dt class="kpi-l">
              {{ k.l }}
              <span v-if="k.delta !== undefined" class="delta" :class="k.delta >= 0 ? 'up' : 'down'">
                {{ k.delta >= 0 ? '▲' : '▼' }} {{ Math.abs(k.delta) }}%
              </span>
            </dt>
            <dd class="kpi-n"><BitsCountUp :to="k.n" :duration="900" /></dd>
            <dd v-if="k.spark" class="kpi-spark"><AdminSparkline :values="k.spark" /></dd>
          </div>
        </dl>

        <div class="range">
          <span class="range-l">Range</span>
          <button type="button" class="a-tab sm" :class="{ active: range === 14 }" @click="range = 14">14 days</button>
          <button type="button" class="a-tab sm" :class="{ active: range === 30 }" @click="range = 30">30 days</button>
        </div>

        <div class="row row-trend">
          <AdminLineChart fig="01" title="Responses over time" :days="trend" />
          <section class="a-panel gauges">
            <header class="a-head">
              <span class="a-fig">Fig. 02</span>
              <h3 class="a-title">Response depth</h3>
              <span class="a-meta">{{ depth.avgRoles }} roles each</span>
            </header>
            <ul class="gauge-list">
              <li v-for="g in gauges" :key="g.l" class="gauge">
                <span class="gauge-l">{{ g.l }}</span>
                <span class="gauge-v">{{ g.v }}%</span>
                <span class="gauge-track" aria-hidden="true">
                  <span class="gauge-fill" :style="{ width: `${g.v}%` }" />
                  <span v-for="t in 9" :key="t" class="gauge-tick" :style="{ left: `${t * 10}%` }" />
                </span>
              </li>
            </ul>
          </section>
        </div>

        <AdminPipeline fig="03" title="Review pipeline" :rows="pipeline" />

        <div class="row row-3">
          <AdminDonut fig="04" title="Where from" :rows="location" />
          <AdminDonut fig="05" title="Has a project" :rows="hasProject" />
          <AdminDonut fig="06" title="Volunteer time" :rows="volunteerTime" />
        </div>

        <AdminHeatmap fig="07" title="When people apply" :grid="heatmap" />

        <div class="charts">
          <AdminBarChart fig="08" title="How they want to take part" :rows="participation" tone="red" />
          <AdminBarChart fig="09" title="Who they are" :rows="selfDescribe" tone="ink" />
          <AdminBarChart fig="10" title="Roles ticked together" :rows="combos" empty="Nobody has picked two roles yet" />
          <AdminBarChart fig="11" title="How they heard" :rows="heardFrom" />
          <AdminBarChart v-if="projectCategories.length" fig="12" title="Project categories" :rows="projectCategories" tone="ink" />
          <AdminBarChart v-if="volunteerAreas.length" fig="13" title="Volunteer areas" :rows="volunteerAreas" />
          <AdminDonut v-if="orgCollaborate.length" fig="14" title="Org wants to collaborate" :rows="orgCollaborate" />
        </div>

        <p class="hint">
          {{ summary.withProject }} respondent(s) said they already have a project to showcase.
        </p>
      </div>

      <!-- RESPONSES inbox -->
      <div v-show="tab === 'responses'" class="responses">
        <div class="toolbar">
          <input
            v-model="search"
            class="inp"
            type="search"
            placeholder="Search name, email, org…"
            aria-label="Search responses"
          />
          <select v-model="filterStatus" class="inp" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option v-for="s in STATUSES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
          <select v-model="filterPart" class="inp" aria-label="Filter by participation">
            <option value="">All participation</option>
            <option v-for="p in PARTICIPATION" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
          <button type="button" class="key key-red" @click="downloadCsv">
            Download CSV
          </button>
        </div>
        <p class="count-line">{{ filtered.length }} of {{ rows.length }} shown</p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Name</th>
                <th>Email</th>
                <th>Participation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in filtered" :key="r.id">
                <tr class="row-item" :class="{ open: openId === r.id }" @click="openId = openId === r.id ? null : r.id">
                  <td class="mono">{{ new Date(r.created_at).toLocaleString() }}</td>
                  <td>{{ r.name }}</td>
                  <td>
                    <a :href="`mailto:${r.email}`" @click.stop>{{ r.email }}</a>
                  </td>
                  <td class="parts-cell">{{ partLabel(r.participation) }}</td>
                  <td @click.stop>
                    <select
                      class="status"
                      :class="`st-${r.status}`"
                      :value="r.status"
                      :aria-label="`Status for ${r.name}`"
                      @change="setStatus(r.id, ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="s in STATUSES" :key="s.value" :value="s.value">
                        {{ s.label }}
                      </option>
                    </select>
                  </td>
                </tr>
                <tr v-if="openId === r.id" class="detail">
                  <td colspan="5">
                    <dl>
                      <div><dt>Location</dt><dd>{{ r.location }}</dd></div>
                      <div>
                        <dt>Describes</dt>
                        <dd>
                          {{ r.self_describe
                          }}{{ r.self_describe_other ? ` — ${r.self_describe_other}` : '' }}
                        </dd>
                      </div>
                      <div v-if="r.make_possible">
                        <dt>Make possible</dt>
                        <dd>{{ r.make_possible }}</dd>
                      </div>
                      <div v-if="r.contribute_text">
                        <dt>Contribute</dt>
                        <dd>{{ r.contribute_text }}</dd>
                      </div>
                      <div v-if="r.project_description">
                        <dt>Project</dt>
                        <dd>{{ r.project_description }}</dd>
                      </div>
                      <div v-if="r.project_categories?.length">
                        <dt>Categories</dt>
                        <dd>{{ r.project_categories.join(', ') }}</dd>
                      </div>
                      <div v-if="r.volunteer_areas?.length">
                        <dt>Volunteer</dt>
                        <dd>
                          {{ r.volunteer_areas.join(', ') }} ({{ r.volunteer_time }})
                        </dd>
                      </div>
                      <div v-if="r.org_name">
                        <dt>Org</dt>
                        <dd>{{ r.org_name }} — collab: {{ r.org_collaborate }}</dd>
                      </div>
                      <div v-if="r.heard_from">
                        <dt>Heard from</dt>
                        <dd>
                          {{ r.heard_from
                          }}{{ r.heard_from_other ? ` — ${r.heard_from_other}` : '' }}
                        </dd>
                      </div>
                      <div v-if="r.anything_else">
                        <dt>Else</dt>
                        <dd>{{ r.anything_else }}</dd>
                      </div>
                      <div v-if="r.phone"><dt>Phone</dt><dd>{{ r.phone }}</dd></div>
                    </dl>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <p v-if="!filtered.length" class="empty">No responses match these filters.</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.panel {
  max-width: 80rem;
  margin: 0 auto;
  font-family: var(--font-readout);
}
.dash-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem;
  padding-bottom: 1.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 2px solid var(--pn-ink);
}
.eyebrow {
  margin: 0 0 0.5rem;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-label);
}
.dash-title {
  margin: 0;
  font-family: var(--font-panel);
  font-weight: 400;
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  line-height: var(--lh-display);
  text-transform: uppercase;
  color: var(--pn-ink);
}
.signed-in {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.9rem 0 0;
  font-size: 0.78rem;
  color: var(--pn-label);
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-cyan);
  box-shadow: 0 0 0 3px rgba(0, 174, 239, 0.2);
  animation: live 2s ease-in-out infinite;
}
@keyframes live { 50% { box-shadow: 0 0 0 6px rgba(0, 174, 239, 0); } }
.dash-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.dash-actions .key { min-height: 42px; padding: 0.8rem 1rem 0.7rem; font-size: 0.75rem; }
.state {
  position: relative;
  margin: 2rem 0;
  padding-top: 1rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pn-label);
}
.state-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 3px;
  background: linear-gradient(90deg, transparent, var(--color-cyan), transparent);
  background-size: 40% 100%;
  background-repeat: no-repeat;
  animation: scan 1.1s linear infinite;
}
@keyframes scan { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.state.err { color: var(--color-red-cta); }
.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--pn-ink);
}
.a-tab {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding: 0 1.25rem;
  margin-bottom: -1px;
  border: 1px solid transparent;
  border-bottom: 0;
  background: transparent;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pn-label);
  cursor: pointer;
}
.a-tab:hover { color: var(--pn-ink); }
.a-tab.active {
  color: var(--pn-ink);
  background: var(--pn-enamel);
  border-color: var(--pn-ink);
  box-shadow: inset 0 3px 0 var(--color-red-cta);
}
.a-tab.sm { min-height: 32px; padding: 0 0.8rem; margin: 0; border-bottom: 1px solid transparent; font-size: 0.68rem; }
.a-tab.sm.active { border-bottom-color: var(--pn-ink); box-shadow: none; background: var(--pn-ink); color: #fff; }
.badge {
  min-width: 1.5rem;
  padding: 0.1rem 0.4rem;
  background: var(--pn-ink);
  color: #fff;
  font-size: 0.68rem;
  text-align: center;
}
.summary { display: grid; gap: 1.25rem; }

/* KPI bank: one ruled strip, not a wall of cards. */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
  margin: 0;
  background: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  box-shadow: 0 1px 2px rgba(34, 34, 34, 0.06), 0 10px 28px rgba(34, 34, 34, 0.08);
  overflow: hidden;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 1rem 1.1rem 1.1rem;
  box-shadow: -1px 0 0 var(--pn-ink), 0 -1px 0 var(--pn-ink);
}
.kpi-big { background: var(--pn-ink); color: #fff; }
.kpi-big .kpi-l { color: #A3A3A3; }
.kpi-big .kpi-n { color: #fff; }
.kpi-alert { box-shadow: -1px 0 0 var(--pn-ink), 0 -1px 0 var(--pn-ink), inset 0 3px 0 var(--color-red-cta); }
.kpi-l {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-label);
}
.delta { letter-spacing: 0; font-weight: 500; }
.delta.up { color: var(--color-cyan-text); }
.delta.down { color: var(--color-red-cta); }
.kpi-n {
  margin: 0;
  font-family: var(--font-panel);
  font-weight: 400;
  font-size: 2.6rem;
  line-height: var(--lh-display);
  color: var(--pn-ink);
}
.kpi-spark { margin: auto 0 0; }
.range { display: flex; align-items: center; gap: 0.25rem; }
.range-l { margin-right: 0.5rem; font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--pn-label); }
.row { display: grid; gap: 1.25rem; }
.row-trend { grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr); }
.row-3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
.gauge-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.gauge { display: grid; grid-template-columns: 1fr auto; row-gap: 0.35rem; font-size: 0.75rem; }
.gauge-l { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.68rem; }
.gauge-v { font-family: var(--font-panel); font-weight: 400; font-size: 1.2rem; line-height: 1; }
.gauge-track { position: relative; grid-column: 1 / -1; height: 10px; border: 1px solid var(--pn-ink); }
.gauge-fill { position: absolute; inset: 0 auto 0 0; background: repeating-linear-gradient(-45deg, var(--color-cyan) 0 3px, #7FD6F7 3px 6px); transition: width 800ms var(--ease-out); }
.gauge-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(34, 34, 34, 0.25); }
.charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: 1.25rem;
}
.hint { margin: 0; font-size: 0.78rem; color: var(--pn-label); }
.toolbar {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr auto;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.count-line { margin: 0 0 0.75rem; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pn-label); }
@media (max-width: 960px) {
  .row-trend { grid-template-columns: 1fr; }
}
@media (max-width: 800px) {
  .toolbar { grid-template-columns: 1fr; }
}
.inp {
  min-height: 44px;
  border: 1px solid var(--pn-ink);
  border-radius: 0;
  padding: 0.45rem 0.75rem;
  font: inherit;
  font-size: 1rem;
  background: var(--pn-enamel);
}
.inp:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.table-wrap {
  background: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  box-shadow: 0 1px 2px rgba(34, 34, 34, 0.06), 0 10px 28px rgba(34, 34, 34, 0.08);
  overflow: auto;
}
table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
th, td {
  text-align: left;
  padding: 0.7rem 0.85rem;
  border-bottom: 1px solid rgba(34, 34, 34, 0.12);
  vertical-align: top;
}
th {
  position: sticky;
  top: 0;
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-label);
  background: var(--pn-enamel);
  border-bottom: 1px solid var(--pn-ink);
}
.mono { white-space: nowrap; color: var(--pn-label); }
.row-item { cursor: pointer; }
.row-item:hover { background: rgba(0, 174, 239, 0.05); }
.row-item.open { background: rgba(0, 174, 239, 0.08); box-shadow: inset 3px 0 0 var(--color-cyan); }
.parts-cell { max-width: 16rem; }
.status {
  font: inherit;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--pn-ink);
  border-radius: 0;
  padding: 0.3rem 0.4rem;
  background: var(--pn-enamel);
}
.status.st-new { box-shadow: inset 3px 0 0 var(--color-red-cta); }
.status.st-reviewed { box-shadow: inset 3px 0 0 var(--color-cyan); }
.status.st-contacted { box-shadow: inset 3px 0 0 var(--pn-ink); }
.status.st-archived { color: var(--pn-label); }
.detail td { background: var(--bg-grouped); }
dl { display: grid; gap: 0.65rem; margin: 0; }
dl > div { display: grid; grid-template-columns: 8rem 1fr; gap: 0.5rem; }
dt { font-weight: 500; color: var(--pn-label); font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; }
dd { margin: 0; white-space: pre-wrap; }
.kpi-grid dt, .kpi-grid dd { white-space: normal; }
.kpi-grid dl > div { display: flex; }
.empty { padding: 1rem; color: var(--pn-label); margin: 0; }
a { color: var(--color-red-cta); }
</style>
