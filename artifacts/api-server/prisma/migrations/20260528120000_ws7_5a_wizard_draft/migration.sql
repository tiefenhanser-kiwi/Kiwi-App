-- WS7-5a — Branch B wizard-draft model.
-- Adds isWizardDraft discriminator so my_plans / home / drafts surfaces can
-- distinguish a wizard-pre-save draft (hidden) from the existing
-- status="draft" rows that already populate the user's plan list.
ALTER TABLE "meal_plan_instances"
  ADD COLUMN "isWizardDraft" BOOLEAN NOT NULL DEFAULT false;

-- New activity event for the wizard expand path (POST /api/wizard/expand).
-- Distinct from wizard_complete (build-plans), so funnel analytics can
-- separate "candidates generated" from "candidate expanded into detail".
ALTER TYPE "ActivityEventType" ADD VALUE 'wizard_candidate_expanded';
