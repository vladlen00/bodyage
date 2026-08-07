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

// Склонение по числу. forms - три формы: для 1, для 2, для 5.
// Правило одно на все слова, поэтому и функция одна: эхо введённого числа
// в разборе результата склоняет свои единицы этой же функцией.
function pluralWord(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b > 1 && b < 5) return forms[1];
  return forms[2];
}

// Склонение слова "год".
function yearsWord(n) { return pluralWord(n, YEARS_FORMS); }

// Склонение слова "день" для строки про начатый замер.
function daysWord(n) { return pluralWord(n, DAYS_FORMS); }

// Сдвиг возраста по нормированной сумме. Отдельной функцией, потому что
// нужен дважды: живому расчёту и восстановлению сохранённого замера.
function shiftForEquivalent(equivalent) {
  const row = AGE_SHIFT.find(r => equivalent >= r.from && equivalent <= r.to) || null;
  return { rawShift: row ? row.shift : 0, title: row ? row.title : "" };
}

// Упёрлась ли цифра в край шкалы, и в какой именно. Экран обязан это сказать:
// живой проход показал, что молчаливый упор читается как поломка приложения.
// Ирена ввела 39 лет с отличными результатами и получила 29, потом ввела 18 с
// теми же результатами и получила 18 с подписью "соответствует возрасту".
//
// clampedTo - сработала граница возраста: урезанный сдвиг разошёлся с
// исходным, то есть цифру держит LIMITS, а не результат.
//
// atScaleTop - сдвиг уже лучший из существующих полос, лучше просто нет.
// Считаем из конфига, а не числом: полосы будут править калибровкой.
// ВАЖНО: это НЕ то же самое, что "все блоки на высший балл". Верхняя полоса
// AGE_SHIFT начинается с 20 из 21, поэтому цифра упирается в предел на балл
// раньше максимума, и улучшение с 20 до 21 её не двигает.
//
// shift сюда приходит УРЕЗАННЫЙ: тот, что реально на экране.
function scaleEdges(equivalent, age, shift) {
  const rawShift = shiftForEquivalent(equivalent).rawShift;
  const bestShift = AGE_SHIFT.reduce((m, x) => Math.min(m, x.shift), Infinity);
  return {
    rawShift,
    clampedTo: shift === rawShift
      ? null
      : (age + rawShift < LIMITS.resultAgeMin ? "min" : "max"),
    atScaleTop: rawShift === bestShift,
  };
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
        // То, по чему считали: для большинства блоков это введённое число,
        // для восстановления пульса - падение, для вставания с пола - баллы
        // по галочкам. Экран показывает его рядом с баллом, чтобы ноль не
        // читался как потерянный ввод.
        value: scored.value,
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

  // Слабого звена НЕТ, когда слабейший балл уже максимальный. Без этой
  // строчки при всех тройках слабейшим назначался первый блок по порядку,
  // и женщина с идеальным результатом читала на экране, что у неё проблема
  // с сердцем. Механика была верная, экран врал.
  if (weakest && weakest.score >= MAX_SCORE_PER_BLOCK) weakest = null;

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

  const band = shiftForEquivalent(equivalent);
  const rawShift = band.rawShift;

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

  // Края шкалы: почему цифру держит не результат, а граница. Правила живут
  // в scaleEdges, потому что тем же вопросом задаётся и восстановленный
  // сохранённый замер.
  const edges = scaleEdges(equivalent, profile.age, shift);

  return Object.assign(base, {
    hasAge: true,
    equivalent,
    rawShift,
    shift,
    bodyAge,
    clampedTo: edges.clampedTo,
    atScaleTop: edges.atScaleTop,
    title: band.title,
  });
}

// ==========================================================================
// ВОССТАНОВЛЕНИЕ СОХРАНЁННОГО ЗАМЕРА
// ==========================================================================
// Собирает объект той же формы, что computeResult, из строки базы. Цифры
// берутся ИЗ СТРОКИ, а не пересчётом: на экране должно быть ровно то, что
// она видела своими глазами в день замера. Пересчёт сегодня дал бы то же
// самое (версия порогов одна и заморожена), но после калибровки разойдётся,
// и молча другая цифра за тот же замер читается как враньё приложения.

// Значение блока в том виде, в каком его показывал экран результата.
// blockRawValue намеренно НЕ режет секунды потолком (сравнению нужно
// введённое число), а scoreBlock режет. Здесь важен экран: женщина с 75
// секундами баланса видела в разборе 60, и увидеть 75 неделю спустя она
// не должна.
function savedBlockValue(blockId, answer) {
  const cfg = SCORING[blockId];
  const v = blockRawValue(blockId, answer);
  if (v === null) return null;
  if (cfg && cfg.cap !== undefined && v > cfg.cap) return cfg.cap;
  return v;
}

function resultFromSaved(row) {
  const answers = (row && row.answers) || {};
  const scores = (row && row.scores) || {};

  const perBlock = [];
  let sum = 0;
  let completed = 0;

  for (const block of BLOCKS) {
    const score = scores[block.id];
    // Ноль это балл, а не отсутствие ответа: проверка строго на пустоту.
    if (score === null || score === undefined) {
      perBlock.push({
        id: block.id, title: block.title, skipped: true, score: null, rating: null,
      });
      continue;
    }
    sum += score;
    completed += 1;
    perBlock.push({
      id: block.id,
      title: block.title,
      skipped: false,
      score,
      rating: null,
      value: savedBlockValue(block.id, answers[block.id]),
    });
  }

  // Слабое звено берём из строки, а не ищем заново: тогда его выбрали по
  // тем порогам, и второй раз тот же вопрос задавать незачем.
  const weakId = row ? row.weakest_block : null;
  const weakest = weakId && WEAK_LINK[weakId]
    ? Object.assign(
        { id: weakId, score: scores[weakId] === undefined ? null : scores[weakId] },
        WEAK_LINK[weakId]
      )
    : null;

  const base = { perBlock, completed, skipped: BLOCKS.length - completed, sum, weakest };

  if (!row || !row.has_age || typeof row.body_age !== "number") {
    return Object.assign(base, { hasAge: false });
  }

  const shift = typeof row.shift === "number" ? row.shift : row.body_age - row.age;

  // Строка про край шкалы объясняет, почему цифру держит ШКАЛА. Значит она
  // имеет право появиться, только если шкала та же самая. После калибровки
  // она объясняла бы уже другие полосы, чем те, по которым посчитана цифра
  // в строке, поэтому при чужой версии порогов её просто нет.
  let edges = { clampedTo: null, atScaleTop: false };
  if (row.config_version === CONFIG_VERSION && typeof row.equivalent === "number") {
    edges = scaleEdges(row.equivalent, row.age, shift);
  }

  return Object.assign(base, {
    hasAge: true,
    equivalent: typeof row.equivalent === "number" ? row.equivalent : null,
    shift,
    bodyAge: row.body_age,
    clampedTo: edges.clampedTo,
    atScaleTop: edges.atScaleTop,
  });
}

// ==========================================================================
// СРАВНЕНИЕ ДВУХ ЗАМЕРОВ
// ==========================================================================
// Сравниваем СЫРЫЕ числа, а не баллы, и не возраст тела.
//
// Причина первая: у возраста тела есть потолок. Минус десять это лучший
// сдвиг из существующих, и женщина, взявшая его на первом замере, получит в
// конце спринта ту же цифру, сколько бы она ни улучшила. Ирена упёрлась в
// потолок сразу, и без сырых чисел показать ей прогресс было бы нечем.
//
// Причина вторая: сырое число не зависит от норм вообще. "25 -> 34 подъёма"
// переживёт калибровку chair_stand без единой правки, тогда как сравнение по
// баллам пришлось бы гнать через одну версию порогов и объяснять пересчёт.
//
// Здесь только арифметика. Направление, потолок и единицы берутся из
// конфига, ни одного числа в логике нет, как и во всём файле.

// Меньше лучше или больше лучше. Форма полос внутри одного блока везде
// одинаковая, below и atLeast в одной таблице не смешиваются, поэтому
// хватает первой попавшейся.
function blockLowerIsBetter(cfg) {
  if (!cfg) return false;
  let list = cfg.bands;
  if (!list && cfg.bySex) list = cfg.bySex[Object.keys(cfg.bySex)[0]];
  if (!list) list = cfg.byAge;
  if (!Array.isArray(list) || list.length === 0) return false;
  // Список может быть либо сразу полосами, либо возрастными группами.
  const first = list[0].bands ? list[0].bands[0] : list[0];
  return !!first && first.below !== undefined;
}

// Потолок сырого числа, если он есть. Дальше него значение не растёт по
// устройству блока, а не по силе женщины: баланс упирается в таймер,
// вставание с пола в "чисто, без опор". Оба числа из конфига.
function blockRawCeiling(cfg) {
  if (!cfg) return null;
  if (cfg.cap !== undefined) return cfg.cap;
  if (cfg.startPoints !== undefined) return cfg.startPoints;
  return null;
}

// Сырое число блока для сравнения. null - сравнивать нечем.
// Восстановление пульса идёт по ПАДЕНИЮ: в зачёт идёт оно, и эхо в разборе
// построено на нём же, иначе женщина сверяла бы рост не с тем числом.
// Секунды НЕ режем потолком, в отличие от scoreBlock: показываем то, что
// она ввела, а упор в потолок отмечаем отдельно.
function blockRawValue(blockId, answer) {
  const cfg = SCORING[blockId];
  if (!cfg || answer === null || answer === undefined) return null;

  if (cfg.input === "checkboxes") {
    if (!floorRiseAnswered(answer, cfg)) return null;
    return floorRisePoints(answer, cfg).points;
  }
  if (cfg.input === "pulse_pair") {
    if (typeof answer.peak !== "number" || typeof answer.after !== "number") return null;
    return pulsePerMinute(answer.peak, cfg) - pulsePerMinute(answer.after, cfg);
  }
  if (typeof answer !== "number" || !isFinite(answer)) return null;
  return answer;
}

// Одна строка сравнения.
// status: better | worse | same | ceiling | no_pair
// Слово better, а не grew: у пульса покоя улучшение это падение числа, и
// "вырос" про него было бы враньём.
function compareBlock(blockId, fromAnswer, toAnswer) {
  const cfg = SCORING[blockId];
  const from = blockRawValue(blockId, fromAnswer);
  const to = blockRawValue(blockId, toAnswer);

  if (from === null || to === null) {
    const missing = from === null && to === null ? "both" : (from === null ? "first" : "last");
    return { id: blockId, from, to, status: "no_pair", missing };
  }

  if (from === to) {
    // Упор в потолок отличаем от простого "не изменилось": женщина с 60
    // секундами из 60 не могла вырасти, и говорить ей "без изменений"
    // нечестно.
    const ceiling = blockRawCeiling(cfg);
    const atCeiling = ceiling !== null && from >= ceiling;
    return { id: blockId, from, to, status: atCeiling ? "ceiling" : "same", missing: null };
  }

  const better = blockLowerIsBetter(cfg) ? to < from : to > from;
  return { id: blockId, from, to, status: better ? "better" : "worse", missing: null };
}

// Сравнение двух замеров целиком, в порядке BLOCKS.
// Знаменатель comparable - блоки, где есть ОБА замера. Блок на потолке из
// знаменателя не выкидываем: подкручивать дробь в свою пользу нельзя, а
// почему он не вырос, видно в его собственной строке.
function compareMeasurements(fromAnswers, toAnswers) {
  const a = fromAnswers || {};
  const b = toAnswers || {};
  const rows = BLOCKS.map(block => {
    const row = compareBlock(block.id, a[block.id], b[block.id]);
    row.title = block.title;
    return row;
  });
  const count = s => rows.filter(r => r.status === s).length;

  return {
    rows,
    comparable: rows.filter(r => r.status !== "no_pair").length,
    better: count("better"),
    worse: count("worse"),
    same: count("same") + count("ceiling"),
  };
}
