-- WS6 6a-5 — Remove dailyCalorieTarget from user_preferences (D-WS6-018).
-- Field was Replit drift, not MVP scope; values in existing rows are fake
-- placeholders so no data movement is required.

ALTER TABLE "user_preferences"
  DROP COLUMN "dailyCalorieTarget";
