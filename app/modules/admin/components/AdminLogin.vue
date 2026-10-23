<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Lock } from '@lucide/vue'
import { useAdminSupabase } from '../composables/useAdminSupabase'
import { getAdminSession, lockAdminSession } from '../composables/useAdminSession'

const email = ref('')
const password = ref('')
const status = ref<'idle' | 'signing-in' | 'error'>('idle')
const message = ref('')
const route = useRoute()

const lockReason = computed(() => {
  const r = route.query.reason
  if (r === 'config') {
    return 'Admin is locked: Supabase URL / anon key are not configured on this deploy.'
  }
  if (r === 'forbidden') {
    return 'That account does not have access to this dashboard.'
  }
  if (r === 'signedout') {
    return 'You were signed out. Sign in again.'
  }
  return ''
})

function nextPath(): string {
  const n = route.query.next
  return typeof n === 'string' && n.startsWith('/admin') ? n : '/admin'
}

onMounted(async () => {
  try {
    const { owner } = await getAdminSession()
    if (owner) await navigateTo(nextPath())
  } catch {
    /* config missing */
  }
})

async function signIn() {
  status.value = 'signing-in'
  message.value = ''
  try {
    const supabase = useAdminSupabase()
    const { error } = await supabase.auth.signInWithPassword({
      email: email.value.trim().toLowerCase(),
      password: password.value,
    })
    if (error) throw error

    const verified = await getAdminSession()
    if (!verified.owner) {
      await lockAdminSession()
      throw new Error('Owner access required')
    }
    await navigateTo(nextPath())
  } catch {
    status.value = 'error'
    message.value = 'Invalid email or password, or this account is not the configured owner.'
  }
}

async function forceLock() {
  try {
    await lockAdminSession()
  } catch {
    /* ignore */
  }
  password.value = ''
  message.value = 'Session cleared.'
  status.value = 'idle'
}
</script>

<template>
  <div class="login-card">
    <div class="lock-badge">
      <Lock :size="14" :stroke-width="2.5" aria-hidden="true" />
      Locked
    </div>
    <h1>Admin sign in</h1>
    <p class="sub">
      This dashboard belongs to one Supabase Auth account.
    </p>

    <div v-if="lockReason" class="lock-banner" role="alert">
      {{ lockReason }}
    </div>

    <form @submit.prevent="signIn">
      <label class="lbl" for="admin-email">Email</label>
      <input
        id="admin-email"
        v-model="email"
        class="inp"
        type="email"
        required
        autocomplete="email"
        placeholder="you@example.com"
      />
      <label class="lbl" for="admin-password">Password</label>
      <input
        id="admin-password"
        v-model="password"
        class="inp"
        type="password"
        autocomplete="current-password"
        required
      />
      <button class="key key-red btn" type="submit" :disabled="status === 'signing-in'">
        {{ status === 'signing-in' ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <p v-if="message" class="msg" :class="{ err: status === 'error' }">{{ message }}</p>
    <button type="button" class="linkish" @click="forceLock">
      Clear any local session
    </button>
  </div>
</template>

<style scoped>
.login-card {
  position: relative;
  max-width: 26rem;
  margin: 4rem auto;
  padding: 2rem 1.75rem 1.5rem;
  background: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  box-shadow: 0 1px 2px rgba(34, 34, 34, 0.06), 0 10px 28px rgba(34, 34, 34, 0.08);
  font-family: var(--font-readout);
}
.login-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 4px;
  background: linear-gradient(90deg, var(--color-red-cta) 0 33%, var(--color-cyan) 33% 66%, var(--pn-ink) 66%);
}
.lock-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.55rem;
  margin-bottom: 1rem;
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #fff;
  background: var(--pn-ink);
}
h1 {
  margin: 0 0 0.6rem;
  font-family: var(--font-panel);
  font-weight: 400;
  font-size: 2.4rem;
  line-height: var(--lh-display);
  text-transform: uppercase;
  color: var(--pn-ink);
}
.sub {
  margin: 0 0 1.5rem;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--pn-label);
}
.lock-banner {
  margin-bottom: 1.25rem;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--color-red-cta);
  box-shadow: inset 3px 0 0 var(--color-red-cta);
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--color-red-cta);
}
.lbl {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-label);
}
.inp {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  margin-bottom: 1.1rem;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--pn-ink);
  border-radius: 0;
  font: inherit;
  font-size: 1rem;
  background: var(--pn-enamel);
}
.inp:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.btn { width: 100%; margin-top: 0.25rem; }
.btn:disabled { opacity: 0.65; cursor: wait; }
.msg { margin: 1rem 0 0; font-size: 0.8rem; color: var(--pn-label); }
.msg.err { color: var(--color-red-cta); }
.linkish {
  display: block;
  width: 100%;
  margin-top: 1.25rem;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.75rem;
  color: var(--pn-label);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
</style>
