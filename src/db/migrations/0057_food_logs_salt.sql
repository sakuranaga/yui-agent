-- 食塩相当量 (g)。日本の栄養成分表示で必須項目 (= kcal / 蛋白質 / 脂質 / 炭水化物 / 食塩相当量)。
-- food_logs と food_reference の両方に追加。既存ロウは NULL のまま。
ALTER TABLE food_logs ADD COLUMN total_salt real;
ALTER TABLE food_reference ADD COLUMN salt real;
