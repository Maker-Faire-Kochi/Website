<script setup lang="ts">
defineProps<{
  label: string
  required?: boolean
  hint?: string
  htmlFor?: string
}>()
</script>

<template>
  <div class="at-field">
    <label v-if="label" class="at-label" :for="htmlFor">
      {{ label }}
      <span v-if="required" class="at-req" aria-hidden="true">*</span>
    </label>
    <p v-if="hint" class="at-hint">{{ hint }}</p>
    <slot />
  </div>
</template>

<style scoped>
.at-field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.at-field + .at-field {
  margin-top: 2rem;
}

.at-label {
  max-width: var(--field-w);
  font-size: 1rem;
  font-weight: 500;
  line-height: 1.45;
  color: var(--pn-ink);
}

.at-req {
  margin-left: 0.2rem;
  color: var(--color-red-cta);
}

.at-hint {
  margin: -0.25rem 0 0.25rem;
  max-width: var(--field-w);
  font-size: 1rem;
  line-height: 1.45;
  color: var(--pn-label);
}
</style>
