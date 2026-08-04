// Возраст тела - чистая логика подсчёта.
// Ни одного порога и ни одного обращения к DOM: пороги живут в config.js,
// экраны в app.js. Здесь только арифметика над конфигом, поэтому файл
// целиком переносим в заход 2 без правок.

// ==========================================================================
// ВЫБОР ПОЛОСЫ И ГРУППЫ
// ==========================================================================

// Полосы перечислены сверху вниз, от лучшей к худшей. Берём первую подходящую.
// Форма { below: X }   - меньше лучше.
// Форма { atLeast: X } - больше лучше.
function pickBand(bands, value) {
  if (!Array.isArray(bands)) return null;
  for (const band of bands) {
    if (band.below !== undefined && value < band.below) return band;
    if (band.atLeast !== undefined && value >= band.atLeast) return band;
  }
  return null;
}

// Возрастная группа. Группы источника начинаются с 20 лет, а вход открыт
// с 18, поэтому первая группа в конфиге объявлена как 18-29.
function pickByAge(groups, age) {
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (age >= g.from && age <= g.to) return g;
  }
  return null;
}

// Список либо сразу полос, либо возрастных групп. Отличаем по наличию from.
function bandsFrom(list, age) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const isAgeGrouped = list[0].from !== undefined;
  if (!isAgeGrouped) return list;
  const group = pickByAge(list, age);
  return group ? group.bands : null;
}

// ==========================================================================
// ВСТАВАНИЕ С ПОЛА
// ==========================================================================

// Переключение одной галочки внутри половины. Правило общее, без привязки
// к конкретным id: exclusive-отметка гасит все остальные в своей половине,
// а выбор любой обычной гасит все exclusive.
// Возвращает НОВЫЙ массив, исходный не трогает.
function toggleFloorRiseOption(current, optionId, cfg) {
  const list = Array.isArray(current) ? current : [];
  const opt = cfg.penalties.find(p => p.id === optionId);
  if (!opt) return list.slice();

  // Снятие галочки всегда простое, никого за собой не тянет.
  if (list.includes(optionId)) return list.filter(id => id !== optionId);

  if (opt.exclusive) return [optionId];

  const exclusiveIds = cfg.penalties.filter(p => p.exclusive).map(p => p.id);
  return list.filter(id => !exclusiveIds.includes(id)).concat(optionId);
}

// Баллы за вставание с пола.
// selections: { descent: [id, ...], rise: [id, ...] }
// Опоры суммируются внутри своей половины, минимум по половине halfMin.
function floorRisePoints(selections, cfg) {
  const halves = {};
  let total = 0;

  for (const half of cfg.halves) {
    const chosen = (selections && selections[half.id]) || [];
    let points = half.points;
    let zeroed = false;

    for (const id of chosen) {
      const p = cfg.penalties.find(x => x.id === id);
      if (!p) continue;
      if (p.zeroesHalf) zeroed = true;
      points -= p.cost;
    }

    if (zeroed) points = cfg.halfMin;
    if (points < cfg.halfMin) points = cfg.halfMin;

    halves[half.id] = points;
    total += points;
  }

  return { points: total, halves };
}

// Половина считается отвеченной, если в ней есть хотя бы одна отметка.
// Блок целиком отвечен, только когда отвечены обе половины.
function floorRiseAnswered(selections, cfg) {
  if (!selections) return false;
  return cfg.halves.every(h => Array.isArray(selections[h.id]) && selections[h.id].length > 0);
}

// ==========================================================================
// ПУЛЬС
// ==========================================================================

// Перевод пятнадцатисекундного счёта в удары в минуту. Множитель живёт в
// конфиге рядом с порогами блока, здесь только умножение.
function pulsePerMinute(value, cfg) {
  const factor = cfg && cfg.perMinuteFactor ? cfg.perMinuteFactor : 1;
  return value * factor;
}

// ==========================================================================
// БАЛЛ ЗА ОДИН БЛОК
// ==========================================================================

// answer  - то, что ввёл человек, или null при пропуске.
// profile - { age, sex }.
// Возвращает { score, ... } либо null, если блок пропущен или ответ пустой.
function scoreBlock(blockId, answer, profile) {
  const cfg = SCORING[blockId];
  if (!cfg) return null;
  if (answer === null || answer === undefined) return null;

  // Вставание с пола: сперва баллы по галочкам, потом полоса.
  if (cfg.input === "checkboxes") {
    if (!floorRiseAnswered(answer, cfg)) return null;
    const fr = floorRisePoints(answer, cfg);
    const band = pickBand(cfg.bands, fr.points);
    return {
      score: band ? band.score : 0,
      value: fr.points,
      halves: fr.halves,
    };
  }

  // Восстановление пульса: в зачёт идёт падение, а не сам пульс.
  let value;
  if (cfg.input === "pulse_pair") {
    if (typeof answer.peak !== "number" || typeof answer.after !== "number") return null;
    // Введено за 15 секунд, пороги собраны для ударов в минуту: переводим
    // ДО применения порогов. 15 и 12 за 15 секунд дают падение 12, а не 3.
    value = pulsePerMinute(answer.peak, cfg) - pulsePerMinute(answer.after, cfg);
  } else {
    if (typeof answer !== "number" || !isFinite(answer)) return null;
    value = answer;
    if (cfg.cap !== undefined && value > cfg.cap) value = cfg.cap;
  }

  // Три формы таблиц: общая, по полу, по возрасту.
  let bands = null;
  if (cfg.bands) {
    bands = cfg.bands;
  } else if (cfg.bySex) {
    bands = bandsFrom(cfg.bySex[profile.sex], profile.age);
  } else if (cfg.byAge) {
    bands = bandsFrom(cfg.byAge, profile.age);
  }
  if (!bands) return null;

  const band = pickBand(bands, value);
  if (!band) return null;

  // Пятиступенчатая и четырёхступенчатая шкалы отдают имя ступени,
  // остальные блоки - сразу балл.
  if (band.rating !== undefined) {
    return { score: cfg.scale[band.rating], rating: band.rating, value };
  }
  return { score: band.score, value };
}

// ==========================================================================
// ИТОГ
// ==========================================================================

// Склонение слова "год".
function yearsWord(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return YEARS_FORMS[2];
  if (b === 1) return YEARS_FORMS[0];
  if (b > 1 && b < 5) return YEARS_FORMS[1];
  return YEARS_FORMS[2];
}

// answers: { blockId: answer | null }. Пропущенный блок = null.
// profile: { age, sex }.
function computeResult(answers, profile) {
  const perBlock = [];
  let sum = 0;
  let completed = 0;

  for (const block of BLOCKS) {
    const scored = scoreBlock(block.id, answers[block.id], profile);
    if (scored) {
      sum += scored.score;
      completed += 1;
      perBlock.push({
        id: block.id,
        title: block.title,
        skipped: false,
        score: scored.score,
        rating: scored.rating || null,
      });
    } else {
      perBlock.push({
        id: block.id,
        title: block.title,
        skipped: true,
        score: null,
        rating: null,
      });
    }
  }

  const skipped = BLOCKS.length - completed;

  // Слабое звено: наименьший балл среди пройденных. При равенстве остаётся
  // первый по порядку BLOCKS, поэтому сравнение строгое, а не нестрогое.
  let weakest = null;
  for (const b of perBlock) {
    if (b.skipped) continue;
    if (weakest === null || b.score < weakest.score) weakest = b;
  }

  const base = {
    perBlock,
    completed,
    skipped,
    sum,
    weakest: weakest
      ? { id: weakest.id, score: weakest.score, ...WEAK_LINK[weakest.id] }
      : null,
  };

  // Пропущено больше двух блоков - возраст не показываем совсем.
  if (completed < RESULT_RULES.minBlocksForResult) {
    return Object.assign(base, { hasAge: false });
  }

  // Пропуск блока не штрафуем: нормируем сумму на число пройденных.
  const equivalent = Math.round(
    (sum / (MAX_SCORE_PER_BLOCK * completed)) * RESULT_RULES.normalizeTo
  );

  const row = AGE_SHIFT.find(r => equivalent >= r.from && equivalent <= r.to) || null;
  const rawShift = row ? row.shift : 0;

  let bodyAge = profile.age + rawShift;

  // Урезание отрицательного сдвига для молодых. Численно совпадает с полом
  // resultAgeMin, но записано отдельным правилом, потому что в конфиге оно
  // отдельное: для тех, кто моложе youngGuardBelowAge, минус не должен
  // утащить результат ниже нижней границы.
  if (rawShift < 0 && profile.age < LIMITS.youngGuardBelowAge && bodyAge < LIMITS.resultAgeMin) {
    bodyAge = LIMITS.resultAgeMin;
  }
  if (bodyAge < LIMITS.resultAgeMin) bodyAge = LIMITS.resultAgeMin;
  if (bodyAge > LIMITS.resultAgeMax) bodyAge = LIMITS.resultAgeMax;

  // Подпись под цифрой строится по УРЕЗАННОМУ сдвигу, иначе цифра 18 и
  // подпись "на 10 лет моложе" будут спорить друг с другом на экране.
  const shift = bodyAge - profile.age;

  return Object.assign(base, {
    hasAge: true,
    equivalent,
    rawShift,
    shift,
    bodyAge,
    title: row ? row.title : "",
  });
}
