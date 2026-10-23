<script setup lang="ts">
import InterestField from './InterestField.vue'
import InterestSection from './InterestSection.vue'
import {
  HAS_PROJECT,
  HEARD_FROM,
  LOCATIONS,
  ORG_COLLABORATE,
  PARTICIPATION,
  PROJECT_CATEGORIES,
  SELF_DESCRIBE,
  VOLUNTEER_AREAS,
  VOLUNTEER_TIME,
} from '~~/shared/interest/constants'
import { MAX_LEN } from '~~/shared/interest/validate'
import { useInterestForm } from '../composables/useInterestForm'

const {
  form,
  submitting,
  submitted,
  errors,
  showContribute,
  showProjectBlock,
  showVolunteer,
  toggleParticipation,
  toggleCategory,
  toggleVolunteerArea,
  submit,
} = useInterestForm()

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
          <h1 class="display at-title">Get Involved</h1>
        </div>
        <div>
          <p class="lede at-lede">
            Maker Faire Kochi is Kerala’s first licensed Maker Faire, built collectively by
            TinkerHub Foundation, MakerGram and Kerala Startup Mission. Tell us how you
            would like to take part.
          </p>
          <p class="at-note">
            This is an interest form, not registration. We'll follow up when the next step opens.
          </p>
        </div>
      </div>
    </header>

    <div class="field field-paper at-body">
      <div class="wrap">
        <div v-if="submitted" class="field-blue at-thanks" role="status">
          <h2>Thanks — you're on our radar.</h2>
          <p>
            We read every response. If you offered to exhibit, volunteer, or partner, expect a
            follow-up as plans firm up.
          </p>
          <a href="/" class="key">Back to Maker Faire Kochi</a>
        </div>

        <form v-else novalidate @submit="onSubmit">
          <!-- honeypot -->
          <div class="at-hp" aria-hidden="true">
            <label for="website">Website</label>
            <input id="website" v-model="form.website" type="text" tabindex="-1" autocomplete="off" />
          </div>

          <InterestSection title="1. Basic information">
            <InterestField label="Name" required html-for="name">
              <input id="name" v-model="form.name" :maxlength="MAX_LEN.name" class="at-input" type="text" name="name" autocomplete="name" required />
            </InterestField>
            <InterestField label="Email address" required html-for="email">
              <input id="email" v-model="form.email" :maxlength="MAX_LEN.email" class="at-input" type="email" name="email" autocomplete="email" required />
            </InterestField>
            <InterestField label="Phone number" hint="Optional" html-for="phone">
              <input id="phone" v-model="form.phone" :maxlength="MAX_LEN.phone" class="at-input" type="tel" name="phone" autocomplete="tel" />
            </InterestField>
            <InterestField label="Where are you from?" required>
              <div class="at-choices" role="radiogroup" aria-label="Where are you from?">
                <label v-for="o in LOCATIONS" :key="o.value" class="at-choice">
                  <input v-model="form.location" type="radio" name="location" :value="o.value" />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
            <InterestField label="What best describes you?" required>
              <div class="at-choices" role="radiogroup" aria-label="What best describes you?">
                <label v-for="o in SELF_DESCRIBE" :key="o.value" class="at-choice">
                  <input v-model="form.selfDescribe" type="radio" name="selfDescribe" :value="o.value" />
                  <span>{{ o.label }}</span>
                </label>
              </div>
              <input
                v-if="form.selfDescribe === 'other'"
                v-model="form.selfDescribeOther"
                :maxlength="MAX_LEN.short"
                class="at-input at-input-follow"
                type="text"
                placeholder="Tell us more"
                aria-label="Other description"
              />
            </InterestField>
          </InterestSection>

          <InterestSection
            title="2. How do you want to be part of Maker Faire Kochi?"
            subtitle="Pick everything that fits — this is the main question."
          >
            <InterestField label="How would you like to participate?" required>
              <div class="at-choices">
                <label v-for="o in PARTICIPATION" :key="o.value" class="at-choice">
                  <input
                    type="checkbox"
                    :checked="form.participation.includes(o.value)"
                    @change="toggleParticipation(o.value)"
                  />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
            <InterestField
              label="What would you like to make possible at Maker Faire Kochi?"
              hint="Ideas beyond the checklist are welcome — that's the spirit of a Maker Faire."
              html-for="makePossible"
            >
              <textarea id="makePossible" v-model="form.makePossible" :maxlength="MAX_LEN.long" class="at-textarea" rows="3" />
            </InterestField>
          </InterestSection>

          <InterestSection v-if="showContribute || showProjectBlock" title="3. If you want to contribute…">
            <InterestField
              v-if="showContribute"
              label="Tell us a little about what you'd like to contribute."
              hint="What do you make, teach, organize, or bring to the community?"
              required
              html-for="contribute"
            >
              <textarea id="contribute" v-model="form.contributeText" :maxlength="MAX_LEN.long" class="at-textarea" rows="4" />
            </InterestField>
            <template v-if="showProjectBlock">
              <InterestField label="Do you already have a project or idea you'd like to showcase?" required>
                <div class="at-choices" role="radiogroup">
                  <label v-for="o in HAS_PROJECT" :key="o.value" class="at-choice">
                    <input v-model="form.hasProject" type="radio" name="hasProject" :value="o.value" />
                    <span>{{ o.label }}</span>
                  </label>
                </div>
              </InterestField>
              <template v-if="form.hasProject === 'yes'">
                <InterestField label="Tell us about your project." required html-for="project">
                  <textarea id="project" v-model="form.projectDescription" :maxlength="MAX_LEN.long" class="at-textarea" rows="4" />
                </InterestField>
                <InterestField label="What category does your project fall under?" required>
                  <div class="at-choices">
                    <label v-for="o in PROJECT_CATEGORIES" :key="o.value" class="at-choice">
                      <input
                        type="checkbox"
                        :checked="form.projectCategories.includes(o.value)"
                        @change="toggleCategory(o.value)"
                      />
                      <span>{{ o.label }}</span>
                    </label>
                  </div>
                </InterestField>
              </template>
            </template>
          </InterestSection>

          <InterestSection v-if="showVolunteer" title="4. For volunteers">
            <InterestField label="What would you like to help with?" required>
              <div class="at-choices">
                <label v-for="o in VOLUNTEER_AREAS" :key="o.value" class="at-choice">
                  <input
                    type="checkbox"
                    :checked="form.volunteerAreas.includes(o.value)"
                    @change="toggleVolunteerArea(o.value)"
                  />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
            <InterestField label="How much time can you contribute?" required>
              <div class="at-choices" role="radiogroup">
                <label v-for="o in VOLUNTEER_TIME" :key="o.value" class="at-choice">
                  <input v-model="form.volunteerTime" type="radio" name="volunteerTime" :value="o.value" />
                  <span>{{ o.label }}</span>
                </label>
              </div>
            </InterestField>
          </InterestSection>

          <InterestSection title="5. Community / organization">
            <InterestField label="Are you part of a makerspace, club, school, college, community, or organization?">
              <div class="at-choices" role="radiogroup">
                <label class="at-choice">
                  <input v-model="form.inOrganization" type="radio" name="inOrg" :value="true" />
                  <span>Yes</span>
                </label>
                <label class="at-choice">
                  <input v-model="form.inOrganization" type="radio" name="inOrg" :value="false" />
                  <span>No</span>
                </label>
              </div>
            </InterestField>
            <template v-if="form.inOrganization === true || form.participation.includes('org_booth')">
              <InterestField label="Organization / community name" required html-for="orgName">
                <input id="orgName" v-model="form.orgName" :maxlength="MAX_LEN.short" class="at-input" type="text" />
              </InterestField>
              <InterestField label="Would your organization be interested in collaborating with Maker Faire Kochi?" required>
                <div class="at-choices" role="radiogroup">
                  <label v-for="o in ORG_COLLABORATE" :key="o.value" class="at-choice">
                    <input v-model="form.orgCollaborate" type="radio" name="orgCollab" :value="o.value" />
                    <span>{{ o.label }}</span>
                  </label>
                </div>
              </InterestField>
            </template>
          </InterestSection>

          <InterestSection title="6. Final">
            <InterestField label="How did you hear about Maker Faire Kochi?">
              <div class="at-choices" role="radiogroup">
                <label v-for="o in HEARD_FROM" :key="o.value" class="at-choice">
                  <input v-model="form.heardFrom" type="radio" name="heardFrom" :value="o.value" />
                  <span>{{ o.label }}</span>
                </label>
              </div>
              <input
                v-if="form.heardFrom === 'other'"
                v-model="form.heardFromOther"
                :maxlength="MAX_LEN.short"
                class="at-input at-input-follow"
                type="text"
                placeholder="Where did you hear about us?"
              />
            </InterestField>
            <InterestField label="Anything else you'd like to tell us?" hint="Optional" html-for="else">
              <textarea id="else" v-model="form.anythingElse" :maxlength="MAX_LEN.long" class="at-textarea" rows="3" />
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

<style scoped src="./form-sheet.css"></style>
