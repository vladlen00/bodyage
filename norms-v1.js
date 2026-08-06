// Возраст тела - НОРМЫ ВЕРСИИ 1. ЗАМОРОЖЕНО, НЕ ПРАВИТЬ.
//
// Это пороги, шкалы и сдвиг возраста ровно в том виде, в каком по ним
// считали замеры с первого дня и до калибровки на живых людях. В каждом
// сохранённом замере лежит config_version, и он указывает СЮДА.
//
// Почему файл существует. Версия в замер писалась с самого начала, а самих
// порогов той версии в коде не было: калибровка правила бы SCORING на месте,
// и старый расчёт стало бы нечем воспроизвести. Тогда сравнение старта с
// финалом в конце спринта соврало бы, потому что считало бы два конца по
// разным шкалам, не зная об этом.
//
// ПРАВИТЬ ЭТОТ ФАЙЛ НЕЛЬЗЯ НИКОГДА, даже чтобы поправить очевидную опечатку
// в пороге: строки в базе уже посчитаны по этим числам. Калибровка кладёт
// РЯДОМ norms-v2.js по этому же образцу, подключает его в index.html перед
// config.js, добавляет в NORMS и поднимает CONFIG_VERSION.
//
// Содержимое перенесено из config.js без единой правки чисел. Обёртка -
// функция, а не голые const: имена внутри локальные и не спорят с живыми
// SCORING и LIMITS, которые config.js объявляет для calc.js и app.js.

const NORMS_V1 = (function () {

  // Заморозка настоящая, вглубь: ни один код не должен дописать сюда поле
  // и тем самым тихо изменить прошлое.
  function deepFreeze(o) {
    Object.getOwnPropertyNames(o).forEach(k => {
      const v = o[k];
      if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
    });
    return Object.freeze(o);
  }

  // ==========================================================================
  // ШКАЛЫ
  // ==========================================================================

  // Пятиступенчатая (отжимания). Имена ступеней сохранены как в источнике,
  // чтобы при перекалибровке было видно происхождение порогов.
  const RATING_SCORE_5 = {
    excellent: 3,   // отлично
    very_good: 3,   // очень хорошо
    good:      2,   // хорошо
    fair:      1,   // удовлетворительно
    below:     0,   // ниже нормы
  };

  // Четырёхступенчатая (подъёмы со стула).
  const RATING_SCORE_4 = {
    excellent: 3,   // отлично
    good:      2,   // хорошо
    average:   1,   // средне
    below:     0,   // ниже нормы
  };

  const MAX_SCORE_PER_BLOCK = 3;

  // ==========================================================================
  // ПОРОГИ ПО БЛОКАМ
  // ==========================================================================
  // Две формы полос:
  //   { below: X }   - меньше лучше, первая подходящая сверху вниз
  //   { atLeast: X } - больше лучше, первая подходящая сверху вниз

  const SCORING = {

    // ---- Пульс покоя. Ввод: удары в минуту -------------------------------
    pulse_rest: {
      input: "number",
      valid: { min: 30, max: 220 },
      bySex: {
        female: [
          { below: 60,       score: 3 },
          { below: 70,       score: 2 },
          { below: 80,       score: 1 },
          { below: Infinity, score: 0 },
        ],
        male: [
          { below: 57,       score: 3 },
          { below: 67,       score: 2 },
          { below: 77,       score: 1 },
          { below: Infinity, score: 0 },
        ],
      },
    },

    // ---- Баланс, глаза открыты. Ввод: секунды ----------------------------
    // Пол не влияет.
    balance_open: {
      input: "seconds",
      cap: 60,
      valid: { min: 0, max: 60 },
      byAge: [
        { from: 18, to: 49, bands: [
          { atLeast: 45, score: 3 },
          { atLeast: 30, score: 2 },
          { atLeast: 15, score: 1 },
          { atLeast: 0,  score: 0 },
        ]},
        { from: 50, to: 69, bands: [
          { atLeast: 40, score: 3 },
          { atLeast: 25, score: 2 },
          { atLeast: 10, score: 1 },
          { atLeast: 0,  score: 0 },
        ]},
      ],
    },

    // ---- Баланс, глаза закрыты. Ввод: секунды ----------------------------
    // Пол не влияет. Потолок 60 задан таймером блока, пороги упираются в 20.
    balance_closed: {
      input: "seconds",
      cap: 60,
      valid: { min: 0, max: 60 },
      byAge: [
        { from: 18, to: 49, bands: [
          { atLeast: 20, score: 3 },
          { atLeast: 12, score: 2 },
          { atLeast: 6,  score: 1 },
          { atLeast: 0,  score: 0 },
        ]},
        { from: 50, to: 69, bands: [
          { atLeast: 10, score: 3 },
          { atLeast: 6,  score: 2 },
          { atLeast: 3,  score: 1 },
          { atLeast: 0,  score: 0 },
        ]},
      ],
    },

    // ---- Восстановление пульса. Ввод: пик и пульс через минуту -----------
    // В зачёт идёт падение = пик минус пульс через минуту.
    // Одинаково для обоих полов и всех возрастов.
    pulse_recovery: {
      input: "pulse_pair",
      // Женщина вводит удары ЗА 15 СЕКУНД, как она их и считает. Умножение
      // делает приложение: считать в уме сразу после 20 приседаний, когда
      // сердце колотится, это лишний шанс ошибиться.
      perMinuteFactor: 4,
      // Границы широкие намеренно. Узкие 8-55 были бы честнее для
      // пятнадцатисекундного счёта, но тогда привычные 140 упирались бы в
      // жёсткую ошибку и не пускали дальше. Мусор они отсекают, остальное
      // ловит мягкая подсказка ниже.
      valid: { min: 8, max: 220 },
      // От этого значения и выше почти наверняка вписан уже умноженный
      // минутный пульс: 55 за 15 секунд это 220 ударов в минуту, выше
      // теоретического максимума для взрослого. Сравнение НЕстрогое именно
      // поэтому: ровно 55 живой прогон уже поймал. Подсказка, а НЕ ошибка.
      softAbove: 55,
      bands: [
        { atLeast: 25,        score: 3 },
        { atLeast: 18,        score: 2 },
        { atLeast: 12,        score: 1 },
        { atLeast: -Infinity, score: 0 },   // пульс мог и вырасти, это ноль, не ошибка
      ],
    },

    // ---- Отжимания. Ввод: число повторов ---------------------------------
    // Возрастные группы источника начинаются с 20 лет, а вход в приложение
    // открыт с 18. Решение: 18-19 считаем по группе 20-29. Отдельных норм
    // для 18-19 в источнике нет, это не пропуск, а осознанная подстановка.
    pushups: {
      input: "reps",
      valid: { min: 0, max: 200 },
      scale: RATING_SCORE_5,
      bySex: {
        // женщины отжимаются с колен
        female: [
          { from: 18, to: 29, bands: [
            { atLeast: 33, rating: "excellent" },
            { atLeast: 25, rating: "very_good" },
            { atLeast: 18, rating: "good" },
            { atLeast: 12, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 30, to: 39, bands: [
            { atLeast: 30, rating: "excellent" },
            { atLeast: 21, rating: "very_good" },
            { atLeast: 15, rating: "good" },
            { atLeast: 10, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 40, to: 49, bands: [
            { atLeast: 27, rating: "excellent" },
            { atLeast: 20, rating: "very_good" },
            { atLeast: 13, rating: "good" },
            { atLeast: 8,  rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 50, to: 59, bands: [
            { atLeast: 24, rating: "excellent" },
            { atLeast: 15, rating: "very_good" },
            { atLeast: 11, rating: "good" },
            { atLeast: 5,  rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 60, to: 69, bands: [
            { atLeast: 21, rating: "excellent" },
            { atLeast: 11, rating: "very_good" },
            { atLeast: 7,  rating: "good" },
            { atLeast: 2,  rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
        ],
        // мужчины отжимаются с носков
        male: [
          { from: 18, to: 29, bands: [
            { atLeast: 39, rating: "excellent" },
            { atLeast: 29, rating: "very_good" },
            { atLeast: 23, rating: "good" },
            { atLeast: 18, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 30, to: 39, bands: [
            { atLeast: 36, rating: "excellent" },
            { atLeast: 29, rating: "very_good" },
            { atLeast: 22, rating: "good" },
            { atLeast: 17, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 40, to: 49, bands: [
            { atLeast: 30, rating: "excellent" },
            { atLeast: 22, rating: "very_good" },
            { atLeast: 17, rating: "good" },
            { atLeast: 12, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 50, to: 59, bands: [
            { atLeast: 25, rating: "excellent" },
            { atLeast: 17, rating: "very_good" },
            { atLeast: 13, rating: "good" },
            { atLeast: 10, rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 60, to: 69, bands: [
            { atLeast: 18, rating: "excellent" },
            { atLeast: 11, rating: "very_good" },
            { atLeast: 8,  rating: "good" },
            { atLeast: 5,  rating: "fair" },
            { atLeast: 0,  rating: "below" },
          ]},
        ],
      },
    },

    // ---- Подъёмы со стула за 30 секунд. Ввод: число повторов -------------
    //
    // ВНИМАНИЕ, НЕ СГЛАЖИВАТЬ.
    // Шкалы 20-59 и 60-69 построены на РАЗНЫХ выборках и между собой не
    // стыкуются: на границе 59 и 60 лет порог падает почти вдвое
    // (женщины: 30 повторов на "отлично" в 50-59 против 18 в 60-64).
    // Это осознанное решение, а не ошибка ввода. Любая попытка "выровнять"
    // ступеньку интерполяцией сломает обе шкалы. Если решим менять - менять
    // источник целиком, а не подгонять стык.
    //
    // Группы 20-59 идут декадами, 60-69 разбита на 60-64 и 65-69.
    // Возраст 18-19 считаем по группе 20-29, как и в отжиманиях.
    //
    // Мужские пороги 20-59 = женские плюс 2 повтора. Числа выписаны явно,
    // а не выведены арифметикой, чтобы в логике не было ни одного порога.
    //
    // РАСХОЖДЕНИЕ ПРОТОКОЛА И ПОРОГОВ, помнить при калибровке.
    // Протокол блока просит КАСАНИЕ сиденья, а не полную посадку: так снято
    // в видео Ирены, приложение обязано совпадать с видео. Пороги ниже взяты
    // из источника, где повтор засчитывался по ПОЛНОЙ посадке. Касание
    // быстрее, за 30 секунд повторов выходит больше, поэтому балл по этому
    // блоку сейчас ЗАВЫШЕН у всех, кто делает касанием, то есть у всей
    // аудитории теста. Снимется калибровкой на живых людях, она уже в плане.
    chair_stand: {
      input: "reps",
      valid: { min: 0, max: 100 },
      scale: RATING_SCORE_4,
      bySex: {
        female: [
          { from: 18, to: 29, bands: [
            { atLeast: 38, rating: "excellent" },
            { atLeast: 31, rating: "good" },
            { atLeast: 25, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 30, to: 39, bands: [
            { atLeast: 36, rating: "excellent" },
            { atLeast: 29, rating: "good" },
            { atLeast: 23, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 40, to: 49, bands: [
            { atLeast: 33, rating: "excellent" },
            { atLeast: 27, rating: "good" },
            { atLeast: 21, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 50, to: 59, bands: [
            { atLeast: 30, rating: "excellent" },
            { atLeast: 24, rating: "good" },
            { atLeast: 19, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          // ---- стык разных выборок, см. комментарий выше ----
          { from: 60, to: 64, bands: [
            { atLeast: 18, rating: "excellent" },
            { atLeast: 15, rating: "good" },
            { atLeast: 12, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 65, to: 69, bands: [
            { atLeast: 17, rating: "excellent" },
            { atLeast: 14, rating: "good" },
            { atLeast: 11, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
        ],
        male: [
          { from: 18, to: 29, bands: [
            { atLeast: 40, rating: "excellent" },
            { atLeast: 33, rating: "good" },
            { atLeast: 27, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 30, to: 39, bands: [
            { atLeast: 38, rating: "excellent" },
            { atLeast: 31, rating: "good" },
            { atLeast: 25, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 40, to: 49, bands: [
            { atLeast: 35, rating: "excellent" },
            { atLeast: 29, rating: "good" },
            { atLeast: 23, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 50, to: 59, bands: [
            { atLeast: 32, rating: "excellent" },
            { atLeast: 26, rating: "good" },
            { atLeast: 21, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          // ---- стык разных выборок, см. комментарий выше ----
          { from: 60, to: 64, bands: [
            { atLeast: 20, rating: "excellent" },
            { atLeast: 16, rating: "good" },
            { atLeast: 14, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
          { from: 65, to: 69, bands: [
            { atLeast: 19, rating: "excellent" },
            { atLeast: 15, rating: "good" },
            { atLeast: 12, rating: "average" },
            { atLeast: 0,  rating: "below" },
          ]},
        ],
      },
    },

    // ---- Вставание с пола. Ввод: галочки, не число -----------------------
    // Старт 10 баллов: 5 за посадку, 5 за подъём. Опоры суммируются внутри
    // своей половины. Минимум по половине 0, в минус не уходим.
    floor_rise: {
      input: "checkboxes",
      startPoints: 10,
      halfMin: 0,
      // hint - своя подсказка на каждый из двух экранов: на втором висела
      // та же строка "сядь на пол и встань обратно", хотя это уже сделано.
      halves: [
        { id: "descent", label: "Посадка на пол", points: 5,
          hint: "Сядь на пол и встань обратно. Отметь все опоры, которые понадобились, чтобы сесть." },
        { id: "rise",    label: "Подъём с пола",  points: 5,
          hint: "Теперь отметь все опоры, которые понадобились, чтобы встать." },
      ],
      // exclusive - взаимоисключающая отметка: она гасит все остальные в своей
      // половине, а выбор любой обычной гасит все exclusive. Флаг обрабатывается
      // в calc.js обобщённо, привязки к конкретным id в логике нет.
      penalties: [
        { id: "clean",       label: "Чисто, без опор",                cost: 0,   exclusive: true },
        { id: "one_hand",    label: "Одной рукой",                    cost: 1   },
        { id: "two_hands",   label: "Двумя руками",                   cost: 2   },
        { id: "forearm",     label: "Предплечьем",                    cost: 1   },
        { id: "one_knee",    label: "На одно колено",                 cost: 1   },
        { id: "two_knees",   label: "На два колена",                  cost: 2   },
        { id: "hand_on_leg", label: "Рукой о колено или бедро",       cost: 1   },
        { id: "side_of_leg", label: "Боком ноги",                     cost: 1   },
        { id: "wobble",      label: "Потеря равновесия",              cost: 0.5 },
        { id: "needed_help", label: "Без помощи или опоры на мебель не получилось",
                             cost: 5, zeroesHalf: true, exclusive: true },
      ],
      bands: [
        { atLeast: 10, score: 3 },
        { atLeast: 8,  score: 2 },   // 8 - 9.5
        { atLeast: 6,  score: 1 },   // 6 - 7.5
        { atLeast: 0,  score: 0 },
      ],
    },
  };

  // ==========================================================================
  // РАСЧЁТ РЕЗУЛЬТАТА
  // ==========================================================================

  const RESULT_RULES = {
    // Пропуск блока не штрафуется: причины бывают честные (болят колени,
    // нет стула). Считаем эквивалент по пройденным блокам и приводим к 21.
    // equivalent = round(sum / (3 * пройденных) * 21)
    normalizeTo: 21,

    // Пропущено больше двух блоков - возраст тела НЕ показываем совсем.
    // Показываем только разбор по блокам.
    minBlocksForResult: 5,
  };

  // Сдвиг в годах по нормализованной сумме баллов.
  const AGE_SHIFT = [
    { from: 20, to: 21, shift: -10, title: "Тело работает как на десять лет моложе" },
    { from: 17, to: 19, shift:  -7, title: "Тело заметно моложе паспорта" },
    { from: 14, to: 16, shift:  -4, title: "Тело моложе паспорта" },
    { from: 11, to: 13, shift:   0, title: "Тело соответствует возрасту" },
    { from:  8, to: 10, shift:   4, title: "Тело чуть старше паспорта" },
    { from:  5, to:  7, shift:   7, title: "Тело старше паспорта" },
    { from:  0, to:  4, shift:  10, title: "Зона внимания" },
  ];

  const LIMITS = {
    entryAgeMin: 18,
    entryAgeMax: 69,
    resultAgeMin: 18,
    resultAgeMax: 85,
    // Ниже этого паспортного возраста отрицательный сдвиг урезаем так,
    // чтобы результат не ушёл ниже resultAgeMin.
    // ВАЖНО: подпись показывает УРЕЗАННЫЙ сдвиг, а не исходный. В 20 лет
    // "на 10 лет моложе" превращается в "на 2 года моложе", иначе цифра
    // 18 и подпись "минус 10" противоречат друг другу на экране.
    youngGuardBelowAge: 28,
  };

  return deepFreeze({
    version: "1",
    ratingScore5: RATING_SCORE_5,
    ratingScore4: RATING_SCORE_4,
    maxScorePerBlock: MAX_SCORE_PER_BLOCK,
    scoring: SCORING,
    resultRules: RESULT_RULES,
    ageShift: AGE_SHIFT,
    limits: LIMITS,
  });
})();
