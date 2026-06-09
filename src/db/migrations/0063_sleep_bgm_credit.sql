-- sleep_bgm に credit 列を追加。
--
-- CC BY 等の attribution-required ライセンスを満たすため、各 preset BGM の
-- 「Title by Artist + ArtistURL + License + LicenseURL」を保存し、
-- SleepModal の BGM 行に hover tooltip として出す (= UI で credit を見える化)。
--
-- user upload (= is_uploaded=true) は NULL (= 自前 BGM はクレジット任意)。
-- legacy preset 5 曲は public/sleep-bgm/credits/*.txt の内容と一致。

ALTER TABLE sleep_bgm
  ADD COLUMN credit TEXT;

UPDATE sleep_bgm
SET credit = 'Sunset Landscape by Keys of Moon
https://soundcloud.com/keysofmoon
Music promoted by https://www.chosic.com/free-music/all/
Creative Commons CC BY 4.0
https://creativecommons.org/licenses/by/4.0/'
WHERE filename = 'bgm_sunset_landscape.mp3';

UPDATE sleep_bgm
SET credit = 'Spa Relax by Alex-Productions
https://onsound.eu/
Music promoted by https://www.chosic.com/free-music/all/
Creative Commons CC BY 3.0
https://creativecommons.org/licenses/by/3.0/'
WHERE filename = 'bgm_spa_relax.mp3';

UPDATE sleep_bgm
SET credit = 'Spatium by Keys of Moon
https://soundcloud.com/keysofmoon
Music promoted by https://www.chosic.com/free-music/all/
Creative Commons CC BY 4.0
https://creativecommons.org/licenses/by/4.0/'
WHERE filename = 'bgm_spatium.mp3';

UPDATE sleep_bgm
SET credit = 'Reverie by Scott Buckley
https://www.scottbuckley.com.au/
Music promoted by https://www.chosic.com/free-music/all/
Creative Commons CC BY 4.0
https://creativecommons.org/licenses/by/4.0/'
WHERE filename = 'bgm_reverie.mp3';

UPDATE sleep_bgm
SET credit = 'MANTRA by Alex-Productions
https://onsound.eu/
Music promoted by https://www.chosic.com/free-music/all/
Creative Commons CC BY 3.0
https://creativecommons.org/licenses/by/3.0/'
WHERE filename = 'bgm_mantra.mp3';
