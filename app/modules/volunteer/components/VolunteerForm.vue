<script setup lang="ts">
import InterestField from '~/modules/interest/components/InterestField.vue'
import InterestSection from '~/modules/interest/components/InterestSection.vue'
import {
  MEDIA_DOMAINS,
  MEDIA_HOURS,
  MEDIA_OCCUPATIONS,
} from '~~/shared/volunteer/constants'
import { MAX_LEN } from '~~/shared/volunteer/validate'
import { useVolunteerForm } from '../composables/useVolunteerForm'

const { form, submitting, submitted, errors, toggleDomain, submit } = useVolunteerForm()

async function onSubmit(e: Event) {
  e.preventDefault()
  await submit()
}
</script>

<template>
  <div class="at-shell">
    <header class="field field-yellow at-hero">
      <div class="wrap at-hero-in">
        <div class="at-title-box">
          <h1 class="display at-title">Media team</h1>
        </div>
        <div>
          <p class="lede at-lede">
            Join the Maker Faire Kochi 2027 Media Team as a videographer, editor, writer,
            or designer, and help tell the stories of makers across Kerala.
          </p>
          <p class="at-note">
            Open to volunteers across Kerala. This is a media-team application, separate
            from the general Get Involved form.
          </p>
        </div>
      </div>
    </header>

    <div class="field field-paper at-body">
      <div class="wrap">
        <div v-if="submitted" class="field-blue at-thanks" role="status">
          <h2>Thank you. Your application has been received.</h2>
          <p>
            Our team will go through the responses and reach out to you via email or
            WhatsApp with the next steps. We look forward to the possibility of creating
            something amazing together!
          </p>
          <a href="/" class="key">Back to Maker Faire Kochi</a>
        </div>

        <form v-else novalidate data-clarity-mask="true" @submit="onSubmit">

          <div class="at-hp" aria-hidden="true">
            <label for="vol-website">Website</label>
            <input id="vol-website" v-model="form.website" type="text" tabindex="-1" autocomplete="off" />
          </div>

          <InterestSection title="1. About you">
            <InterestField label="Full name" required html-for="vol-name">
              <input
                id="vol-name"
                v-model="form.name"
                :maxlength="MAX_LEN.name"
                class="at-input"
                type="text"
                name="name"
                autocomplete="name"
                required
              />
            </InterestField>
            <InterestField label="Email address" required html-for="vol-email">
              <input
                id="vol-email"
                v-model="form.email"
                :maxlength="MAX_LEN.email"
                class="at-input"
                type="email"
                name="email"
                autocomplete="email"
                required
              />
            </InterestField>
            <InterestField label="Phone number (WhatsApp)" required html-for="vol-phone">
              <input
                id="vol-phone"
                v-model="form.phone"
                :maxlength="MAX_LEN.phone"
                class="at-input"
                type="tel"
                name="phone"
                autocomplete="tel"
                required
              />
            </InterestField>
            <InterestField label="Location" hint="Optional" html-for="vol-location">
              <input
                id="vol-location"
                v-model="form.location"
                :maxlength="MAX_LEN.location"
                class="at-input"
                type="text"
                name="location"
                autocomplete="address-level2"
              />
            </InterestField>
            <InterestField label="Occupation" hint="Optional">
              <div class="at-choices" role="radiogroup" aria-label="Occupation">
                <label v-for="o in MEDIA_OCCUPATIONS" :key="o.value" class="at-choice">
                  <input v-model="form.occupation" type="radio" name="occupation" :value="o.value" />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
          </InterestSection>

          <InterestSection
            title="2. How you want to contribute"
            subtitle="Pick every media domain that fits."
          >
            <InterestField label="Which domain would you like to contribute to?" required>
              <div class="at-choices">
                <label v-for="o in MEDIA_DOMAINS" :key="o.value" class="at-choice">
                  <input
                    type="checkbox"
                    :checked="form.domains.includes(o.value)"
                    @change="toggleDomain(o.value)"
                  />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
            <InterestField
              label="Portfolio or previous work"
              hint="Optional — a link to samples, Instagram, Drive, or a reel"
              html-for="vol-portfolio"
            >
              <input
                id="vol-portfolio"
                v-model="form.portfolioUrl"
                :maxlength="MAX_LEN.portfolio"
                class="at-input"
                type="text"
                name="portfolio"
                inputmode="url"
                placeholder="https://"
                autocomplete="url"
              />
            </InterestField>
            <InterestField label="Hours per week during the build-up" required>
              <div class="at-choices" role="radiogroup" aria-label="Hours per week">
                <label v-for="o in MEDIA_HOURS" :key="o.value" class="at-choice">
                  <input v-model="form.hoursPerWeek" type="radio" name="hours" :value="o.value" required />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
          </InterestSection>

          <div class="at-end">
            <div class="at-end-col">
              <div v-if="errors.length" class="at-errors" role="alert">
                <p v-for="(err, i) in errors" :key="i">{{ err }}</p>
              </div>
              <button class="key key-red at-submit" type="submit" :disabled="submitting">
                {{ submitting ? 'Sending…' : 'Submit' }}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped src="../../interest/components/form-sheet.css"></style>
