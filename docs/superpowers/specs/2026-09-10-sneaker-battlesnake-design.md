# Sneaker — Diseño Técnico

Fecha: 2026-09-11 (revisión 2; la primera versión es del 2026-09-10 y vive
en el historial de git)
Estado: aprobado para plan de implementación

## 1. Objetivo

Motor de decisión para Battlesnake llamado **Sneaker**. Heurístico espacial
envuelto en búsqueda con profundidad iterativa. Sin redes neuronales ni
llamadas a IA en tiempo de decisión. Sin estado persistente.

Dos escenarios de competencia:

- **FFA**: 4 serpientes, tablero 11x11, ruleset estándar.
- **Duel King**: 1v1, mismo tablero y ruleset.

### Criterios de éxito

1. Cero muertes por inanición y cero muertes por movimiento ilegal.
2. Cero timeouts. Siempre devuelve un movimiento dentro del presupuesto.
3. En el arena, el vector de pesos afinado gana ≥60% de partidas contra un
   baseline de profundidad 0 (heurística pura, sin búsqueda), medido como
   `victorias / partidas totales`. Los empates por muerte mutua cuentan en
   el denominador — ver el criterio 5.
4. Profundidad alcanzada: ≥4 en duelo, ≥2 en FFA de 4, en el 90% de turnos.
5. **Cero muertes mutuas voluntarias.** El arena registra, por cada muerte
   mutua, si Sneaker tenía otro movimiento legal en ese turno. Si lo tenía,
   la muerte fue voluntaria y es un bug: el filtro duro de head-to-head (§8)
   prohíbe entrar a una casilla que un rival de longitud igual o mayor puede
   alcanzar. Una muerte mutua forzada — todos los movimientos legales
   terminan en choque — es un resultado legítimo de un late game estrecho y
   no cuenta contra este criterio.

   La tasa bruta de muertes mutuas se reporta como señal de humo, no como
   umbral: una tasa alta con cero voluntarias significa tableros estrechos,
   no un filtro roto.

   El formato del torneo resuelve las muertes mutuas de bracket con una
   revancha de muerte súbita (y por sembrado si no hay tiempo), así que no
   son un riesgo de eliminación silenciosa. Este criterio existe por
   corrección del filtro, no por el torneo: un filtro que deja pasar
   choques contra iguales también deja pasar choques contra más largos, y
   eso es derrota sin revancha.

### Evidencia preliminar

Un simulador simplificado (no el motor de producción) corrió 150 duelos de
profundidad 3 contra profundidad 0: 81 victorias, 36 derrotas, 33 muertes
mutuas. Excluyendo empates, 69.2% — el intervalo de confianza al 95% es
aproximadamente ±8%, así que cubre el umbral del 60% pero con poco margen.

**El 22% de muertes mutuas es una alarma, no un dato de referencia.** El
simulador o bien no implementó el filtro de head-to-head, o bien usó
tableros de partida irrealmente estrechos. El arena real distingue los dos
casos registrando si cada muerte fue forzada o voluntaria — ver criterio 5.

Estos números validan la dirección de la función de evaluación. No validan
el motor, que todavía no existe.

## 2. Restricciones

### Presupuesto de tiempo

Battlesnake otorga 500ms por movimiento. Reparto objetivo:

| Concepto | ms |
|---|---|
| Round-trip de red + parseo | ~100 (reservado) |
| Búsqueda | `SEARCH_BUDGET_MS` (corte duro) |
| Serialización + margen | 50 |

`SEARCH_BUDGET_MS` es una constante exportada, con valor inicial 350. El
valor definitivo se fija midiendo el round-trip real entre el motor oficial
de Battlesnake y la máquina de despliegue — la tabla de arriba es el punto
de partida, no la cifra final.

La búsqueda consulta el reloj en cada nodo y aborta al cruzar el deadline,
descartando la profundidad parcial en curso. Como la profundidad iterativa
siempre conserva el mejor resultado del último nivel completo, reducir el
presupuesto degrada la calidad de forma continua en vez de romper nada.

### Plataforma: Fly.io

Una máquina siempre activa en Fly.io, `shared-cpu-1x`, 256MB,
`min_machines_running: 1`. Costo estimado: 2–5 USD/mes.

La primera versión de este diseño asumía Cloudflare Workers por su cold
start cercano a cero. Se descartó por un problema que no tiene solución
dentro del diseño:

**El reloj no avanza durante ejecución síncrona en Workers.** Como
mitigación de ataques de temporización tipo Spectre, `Date.now()` y
`performance.now()` en Workers solo avanzan al cruzar un punto de I/O. El
mecanismo central de este diseño — consultar el reloj en cada nodo del
árbol para abortar al cruzar el deadline — es literalmente inejecutable ahí:
el chequeo nunca dispara, y el runtime mata el Worker por límite de CPU sin
corte gracioso. Insertar `await` periódicos en el bucle caliente para forzar
el avance del reloj es posible, pero convierte una recursión síncrona en
asíncrona y añade overhead exactamente donde menos se puede pagar.

Fly.io es una VM real con Node estándar: el reloj se comporta normalmente,
no hay unidad de CPU-ms facturable distinta del tiempo de pared, y los
500ms del protocolo se tratan como wall-clock sin sorpresas.

**Riesgo abierto: throttling en CPU compartida.** Un turno de ~350ms de
búsqueda cada ~500ms es ~70% de utilización sostenida durante toda una
partida. Los vCPU compartidos de Fly.io tienen cuota base y ráfaga; carga
sostenida puede ser limitada. Se mide `nodos/segundo` en la máquina
desplegada, no solo en local, y si hay throttling se sube a
`performance-1x`. Es un cambio de configuración, no de código.

### Portabilidad de plataforma

**El motor no contiene APIs específicas de plataforma.** `board.js`,
`space.js`, `eval.js` y `search.js` usan exclusivamente JavaScript estándar.
`index.js` es un adaptador delgado sobre `node:http` — cuatro rutas no
justifican Express ni Hono, y cero dependencias es una restricción de este
proyecto, no una preferencia.

La consecuencia: el mismo motor corre sin modificación en cualquier runtime
con reloj funcional. Cambiar de plataforma reescribe `index.js` y nada más.

### Sin estado

Todo movimiento se computa exclusivamente desde el payload de la petición.
Sin base de datos, sin caché entre turnos, sin memoria de partidas
anteriores. Esto mantiene el despliegue trivial y elimina una clase entera
de bugs.

Una tabla de transposición **dentro de una misma llamada** a `findMove`,
descartada al devolver el movimiento, no viola esta restricción. Es memoria
de trabajo, no estado.

### Sin IA en tiempo de decisión

Se evaluó y se descarta explícitamente invocar una API de LLM durante el
turno. Tres razones, y ninguna es solo de rendimiento:

1. **El presupuesto no lo permite.** 500ms es el turno completo, incluido el
   viaje de red al motor de Battlesnake. Una llamada a un proveedor de IA
   añade latencia variable que ningún deadline interno puede acotar — el
   proveedor no le debe nada a nuestro presupuesto.
2. **Introduce un modo de fallo correlacionado.** Un incidente del
   proveedor durante una ronda de torneo pierde todas las partidas a la
   vez. El diseño sin estado y sin dependencias externas existe para que
   eso no pueda pasar.
3. **No resuelve nada que el diseño no resuelva ya.** El único problema
   para el que se consideró — romper simetría en partidas espejo — resulta
   ser mucho más pequeño de lo que parecía (§8).

**Dónde sí entra la IA: offline.** Proponer variantes de pesos, generar
escenarios de arena, analizar resultados — todo antes del despliegue. El
artefacto que corre en producción sigue siendo un objeto de pesos y
aritmética pura.

## 3. Módulos

```
src/
  index.js     adaptador HTTP sobre node:http
  board.js     parseo, grilla de ocupación, simulación de turno
  space.js     flood fill tail-aware, Voronoi BFS
  eval.js      función de evaluación
  weights.js   vectores de peso por modo, OPPONENT_CAP, SEARCH_BUDGET_MS
  search.js    profundidad iterativa, alpha-beta paranoico, move ordering
test/
  arena.js     runner de partidas locales contra board.js de producción
  *.test.js    pruebas unitarias (node:test)
```

**Hay un solo simulador.** El arena reutiliza `board.js` de producción para
que exista una única fuente de verdad sobre las reglas del juego. El
simulador simplificado que produjo la evidencia preliminar de §1 cumplió su
función y no forma parte del repositorio: dos simulaciones divergen, y
alguien acabará confiando en la que es más rápida pero no es la real.

## 4. Semántica de simulación

Esta sección define el modelo del juego. La corrección aquí es la base de
todo lo demás.

### Coordenadas

`(0,0)` es la esquina inferior izquierda. `up` = y+1, `down` = y-1,
`left` = x-1, `right` = x+1. Las dimensiones se leen de `board.width` y
`board.height` — no se hardcodea 11.

### Orden de resolución de un turno

1. Cada serpiente mueve la cabeza una casilla; el cuerpo la sigue y la cola
   se retrae.
2. Salud -1 para cada serpiente.
3. Si la cabeza queda sobre comida: salud = 100, la cola **no** se retrae
   este turno (crecimiento), la comida se consume.
4. Eliminaciones, evaluadas sobre el estado posterior al movimiento:
   - salud ≤ 0 → inanición
   - cabeza fuera del tablero → pared
   - cabeza sobre un segmento corporal (propio o ajeno) que no se vacía
     este turno → colisión
   - dos cabezas en la misma casilla → muere la más corta; si son de igual
     longitud, mueren ambas

### Modelo de vaciado de casillas

Para una serpiente de longitud `n` con cuerpo `B[0..n-1]` (`B[0]` = cabeza),
el segmento en el índice `i` se vacía en el turno `n - i`:

- `B[n-1]` (cola) → libre en el turno 1
- `B[0]` (cabeza) → libre en el turno `n`

Cuando una serpiente come, la API duplica el segmento de cola en el array.
Al construir la grilla, si varios segmentos ocupan la misma casilla se toma
el **máximo** de sus tiempos de vaciado. Esto resuelve el caso "acaba de
comer" sin lógica especial: la casilla duplicada hereda el mayor de los dos
tiempos y correctamente permanece bloqueada un turno extra.

La grilla resultante — 0 para casillas vacías, `n - i` para ocupadas — es la
entrada compartida de flood fill y Voronoi.

### Representación en memoria

`freeAt` es una **`Int8Array` plana**, indexada por `idx = y * ancho + x`.
No un array anidado `[x][y]`.

Dos razones, ambas de rendimiento y ninguna prematura:

- Un array anidado cuesta dos indirecciones de memoria por acceso; la plana
  cuesta una. El flood fill y el Voronoi tocan cada casilla varias veces por
  nodo del árbol.
- Instanciar arrays nuevos en cada simulación de turno dispara el recolector
  de basura, y el GC consume exactamente el presupuesto de CPU que la
  búsqueda necesita.

Los buffers se **preasignan al inicio de la búsqueda y se reutilizan**: un
pool indexado por profundidad, `buffers[depth]`, con `MAX_DEPTH` entradas.
Cada nivel de la recursión escribe en el suyo, así que un nodo padre
conserva su estado mientras el hijo trabaja.

Los **bitboards** quedan como optimización posterior. `freeAt` almacena
conteos de turno, no booleanos, así que un bitboard requeriría planos de
bits — bastante más complejidad, probablemente innecesaria una vez eliminada
la presión de GC. Se reconsidera solo si la instrumentación del arena (§10)
muestra que la asignación de memoria sigue siendo el cuello de botella.

## 5. Algoritmos espaciales

### Flood fill tail-aware

BFS desde una casilla origen. Una casilla ocupada es transitable si la
distancia BFS `d` hasta ella satisface `d >= freeAt[celda]` — es decir, si
para cuando lleguemos ahí el segmento ya se habrá movido.

Esto corrige el error de tratar todos los cuerpos como muros permanentes,
que sobreestima el peligro y descarta escapes válidos. Es lo que hace viable
el tail-chasing sin lógica dedicada: seguir la propia cola emerge
naturalmente de un flood fill que sabe que la cola se va.

Devuelve el conteo de casillas alcanzables.

Umbral de eliminación: un movimiento se descarta si el flood fill resultante
es `< length - 1`. **No `< length`** — la cola se retrae, así que el espacio
mínimo viable es uno menos que la longitud.

### Voronoi BFS

BFS multi-fuente sembrado con todas las cabezas a distancia 0,
simultáneamente. Cada casilla es reclamada por la primera cabeza que la
alcanza. En empate de distancia, la reclama la serpiente más larga (gana el
head-to-head); si son de igual longitud, la casilla queda en disputa y no
cuenta para nadie.

Usa la misma grilla `freeAt`, así que respeta el vaciado de colas.

Manhattan puro se descarta: ignora cuerpos y paredes, lo que hace que Sneaker
"crea" controlar casillas inalcanzables. En 11x11 el BFS cuesta ~121
operaciones — el argumento de rendimiento a favor de Manhattan no existe.

## 6. Función de evaluación

`evaluate(state, weights) → number`, desde la perspectiva de Sneaker.

### Terminales

- Sneaker muerta → `-1e9 + profundidad` (prefiere morir más tarde)
- Sneaker única viva → `+1e9 - profundidad` (prefiere ganar antes)

### Términos

| Término | Cálculo | Rango |
|---|---|---|
| `space` | flood fill desde nuestra cabeza / casillas totales | 0..1 |
| `terr` | casillas Voronoi propias / casillas libres | 0..1 |
| `lenAdv` | (nuestra longitud − longitud del rival más largo) / ancho, acotado a ±1 | -1..1 |
| `center` | 1 − (distancia Manhattan al centro / `radioMax`) | 0..1 |
| `food` | ver abajo | 0..1, o `HUNGER_OVERRIDE` |

donde `radioMax = floor(ancho/2) + floor(alto/2)` — la distancia Manhattan
desde una esquina al centro, 10 en un tablero 11x11.

Resultado: suma ponderada de los términos.

### Urgencia de comida

```
d = distancia BFS a la comida alcanzable más cercana
si no hay comida alcanzable → 0

hambre = salud <= d + 2
si hambre → devuelve HUNGER_OVERRIDE

base = (100 - salud) / 100
crecimiento = nuestra longitud <= longitud del rival más largo ? 0.5 : 0
devuelve (base + crecimiento) * (1 - d / (ancho + alto))
```

**La comida es un peso, no un filtro.** Como quinto paso secuencial solo
podría ganar cuando todos los demás criterios empatan; con salud al 10% y la
comida en una dirección de bajo Voronoi, esa arquitectura mata de hambre a
la serpiente. Como término ponderado, la urgencia escala de forma continua y
compite de verdad contra el control territorial.

**`HUNGER_OVERRIDE = 100` es una salvaguarda dura.** Si la salud no alcanza
para llegar a la comida más cercana con dos turnos de margen, comer se vuelve
dominante. Los demás términos están acotados a 0..1 y sus pesos suman menos
de 9 en ambos vectores, así que `food × 100` supera cualquier combinación
posible por un margen amplio. Si los pesos se afinan al alza, esta relación
debe reverificarse.

**El crecimiento temprano se ata a la ventaja de longitud, no al número de
turno.** Mientras no seamos estrictamente los más largos, la comida pesa más;
una vez que dominamos en longitud, el peso cae y priorizamos el espacio.

### Vectores de peso

```js
export const WEIGHTS = {
  ffa:  { space: 3.0, terr: 2.0, len: 1.0, center: 0.0, food: 1.5 },
  duel: { space: 3.0, terr: 3.5, len: 1.5, center: 0.8, food: 1.0 },
};

export const OPPONENT_CAP = 2;
export const SEARCH_BUDGET_MS = 350;
```

Valores iniciales, destinados a ser afinados por el arena. El modo se
selecciona por `board.snakes.length` — 2 serpientes vivas → `duel`, más →
`ffa`.

Los modos son vectores de peso, no ramas de código. Una sola ruta de
ejecución, diffeable y afinable por búsqueda en rejilla offline.

**`center` vale 0 en FFA y positivo en duelo.** Preferir bordes en FFA está
invertido: un borde reduce las salidas de 4 a 3, una esquina a 2. Pero
premiar el centro en FFA tampoco es correcto, por una razón distinta a la
del peligro: **`center` es un proxy crudo de un espacio que `terr` ya mide
directamente y mejor.** Si tres rivales se amontonan en el medio, los
flancos quedan como territorio no disputado y el Voronoi los premia solo. El
flanqueo emerge de `terr`, no de penalizar el centro.

En duelo el centro sí tiene valor propio: la geometría de partir el tablero
en dos mitades depende de ocupar el eje medio, y eso `terr` no lo expresa
igual de bien.

Un peso negativo en FFA queda descartado: empujaría a Sneaker hacia casillas
de 3 y 2 salidas de forma activa, que es el modo de fallo que este término
existe para evitar.

## 7. Búsqueda

### Profundidad iterativa

```
findMove(gameState):
  deadline = now + SEARCH_BUDGET_MS
  legales = movimientos que sobreviven los filtros duros (§8)
  si legales vacío → cadena de respaldo (§9)
  mejor = elección heurística de profundidad 0   # siempre disponible
  para profundidad = 1, 2, 3, ...:
    intenta:
      mejor = alphabeta(estado, profundidad, -inf, +inf, deadline).move
    captura Timeout:
      rompe                                       # descarta nivel parcial
  devuelve mejor
```

La profundidad se autoajusta al factor de ramificación: en duelo llega a
5-6, en FFA de 4 llega a 2-3, con el mismo código y el mismo presupuesto.
`profundidad = 0` es exactamente la serpiente heurística pura — sirve de
baseline en el arena y de respaldo en producción.

### Move ordering

En cada iteración, el mejor movimiento de la iteración anterior se explora
primero. Es la ganancia más barata de la poda alpha-beta — un buen primer
movimiento produce cortes tempranos en todo el subárbol — y son cinco
líneas. No se difiere.

### Tabla de transposición

Opcional, dentro de una sola llamada a `findMove`. Se añade solo si la
instrumentación del arena muestra que la búsqueda revisita estados con
frecuencia. En un árbol de profundidad 4-6 sobre un tablero 11x11 el
beneficio no es obvio a priori.

### Modelo paranoico

Battlesnake es de movimiento simultáneo, lo que no es minimax puro. La
aproximación práctica: Sneaker mueve primero, los oponentes responden.

Todos los oponentes que entran al árbol se colapsan en un único jugador
minimizante que elige el movimiento conjunto que peor deja a Sneaker. Es
pesimista — asume coordinación que no existe — pero errar hacia la
supervivencia es el sesgo correcto para una serpiente evasiva.

Poda alpha-beta estándar sobre este árbol de dos jugadores.

Aunque Sneaker mueva "primero" en el modelo secuencial, la resolución de
head-to-head se evalúa en el paso de resolución del turno, no tratando las
cabezas rivales como estáticas. Un choque frontal contra un rival igual o más
largo es una eliminación, y la búsqueda debe verla.

### Qué oponentes entran al árbol

Dos filtros, aplicados en orden:

1. **Proximidad.** Un oponente es candidato si
   `manhattan(nuestraCabeza, suCabeza) <= 2 * profundidad + 2`. Fuera de ese
   radio no puede alcanzarnos dentro del horizonte de búsqueda.
2. **`OPPONENT_CAP`.** De los candidatos, entran al minimizador conjunto los
   `OPPONENT_CAP` más cercanos. El resto se trata como obstáculo estático
   (su cuerpo permanece, no se mueve) aunque esté dentro del radio.

El segundo filtro acota el peor caso combinatorio que el primero no acota:
cuatro serpientes agrupadas ponen a los tres rivales dentro del radio a la
vez. Medición en el simulador preliminar, profundidad 4, en ese escenario:

| `OPPONENT_CAP` | Nodos | Tiempo |
|---|---|---|
| sin límite | 10,548 | 962 ms |
| 2 | 3,772 | 241 ms |
| 1 | 184 | 30 ms |

`OPPONENT_CAP = 1` es demasiado agresivo: trata a un segundo rival adyacente
como estático y puede ignorar una amenaza real de choque. `2` es el valor
por defecto. Es una constante afinable, no una rama de código.

### Determinismo y partidas espejo

Se planteó como riesgo que dos instancias de Sneaker con los mismos pesos,
en posiciones simétricas, produjeran partidas estancadas en espejo. La
evidencia preliminar no lo sostiene:

- 100 partidas espejo con posiciones aleatorias: 0 agotaron el límite de
  turnos.
- Espejo con simetría rotacional de 180° exacta: partida decisiva.

La razón es que el orden fijo de exploración (`up, down, left, right` en
coordenadas absolutas) ya rompe la simetría por sí solo. Bajo rotación,
"arriba" no significa lo mismo para una serpiente cerca de una esquina que
para su espejo en la opuesta. Bajo reflexión izquierda-derecha, `up` y
`down` son invariantes pero `left` y `right` se intercambian, así que
cualquier empate entre `left` y `right` también rompe la simetría. El único
caso que sobrevive es una partida donde todos los empates son entre `up` y
`down` bajo reflexión horizontal — lo bastante estrecho como para no
diseñar en torno a él.

**No se añade un término de desempate.** Una versión anterior de esta
revisión proponía `tieBreak = ε × índiceDeSerpiente`, y se observó que no
cambiaba ningún resultado. No podía: es una constante sumada a todas las
hojas del árbol de una misma serpiente, y un offset constante no altera qué
movimiento gana el argmax. Si el caso de reflexión horizontal aparece en el
arena, la forma correcta de romperlo es rotar el orden de exploración de
movimientos por índice de serpiente — eso sí depende del movimiento. Se
añade entonces, no antes.

## 8. Filtros duros

Antes de puntuar, se eliminan movimientos:

1. Fuera del tablero.
2. Contra un segmento corporal que no se vacía a tiempo.
3. Head-to-head perdedor: casilla adyacente a la cabeza de un rival de
   longitud igual o mayor. Un rival adyacente a comida se trata como si ya
   hubiera crecido.
4. Flood fill resultante `< length - 1`.

El filtro de head-to-head va aquí, junto a la supervivencia, y no después
del scoring. Como filtro previo no hay conflicto posible entre "Voronoi
prefiere este movimiento" y "combate lo prohíbe".

## 9. Cadena de respaldo

Sneaker nunca devuelve un error ni omite un movimiento:

1. Mejor movimiento de la búsqueda.
2. Mejor heurístico de profundidad 0 entre los legales.
3. Cualquier movimiento no inmediatamente fatal.
4. Cualquier movimiento dentro del tablero.
5. `"up"`.

Cualquier excepción no capturada dentro del handler cae a esta cadena. Un
movimiento malo pierde una partida; un timeout o un 500 la pierde igual pero
además oculta el bug.

## 10. Endpoints HTTP

| Ruta | Método | Respuesta |
|---|---|---|
| `/` | GET | metadatos de apariencia (`apiversion`, `author`, `color`, `head`, `tail`) |
| `/start` | POST | 200, cuerpo vacío |
| `/move` | POST | `{ "move": "up\|down\|left\|right", "shout": string }` |
| `/end` | POST | 200, cuerpo vacío |

`/start` y `/end` no guardan nada — existen porque el protocolo los exige.

## 11. Arena y pruebas

### Arena

`test/arena.js` reutiliza la simulación de turno de `board.js` para correr
partidas completas localmente. Como la búsqueda ya necesita simular turnos,
el arena es casi gratis una vez que `board.js` existe.

```bash
node test/arena.js --games 500 --a ffa --b experimental
```

Reporta, desglosado:

- victorias / derrotas / muertes mutuas, por separado
- muertes mutuas **forzadas vs voluntarias** — voluntaria significa que
  Sneaker tenía otro movimiento legal ese turno
- turnos de supervivencia promedio
- causas de muerte: pared, cuerpo, head-to-head, inanición

La distinción forzada/voluntaria es el criterio de éxito 5. Es lo que
convierte "hubo muchos empates" en "el filtro está roto" o en "los tableros
son estrechos", que exigen respuestas opuestas.

Esto es lo que convierte el afinado de pesos en medición en vez de
adivinanza, y es la razón por la que se construye antes que la búsqueda.

### Instrumentación de rendimiento

El arena mide el costo de la búsqueda, porque de ahí sale el valor de
`SEARCH_BUDGET_MS` y la decisión sobre el tamaño de máquina:

- nodos evaluados por segundo — en local y en la máquina desplegada
- CPU-ms por profundidad alcanzada, separado por duelo y FFA
- distribución de profundidad alcanzada por turno

### Pruebas unitarias

`node:test` y `node:assert`, nativos. Sin framework, sin dependencias.

Cobertura mínima:

- **Simulación**: retracción de cola, crecimiento al comer, colisión contra
  pared, colisión corporal, head-to-head de longitudes distintas e iguales,
  y el caso legal de moverse a la casilla que una cola está desocupando.
- **Flood fill**: conteos esperados en tableros conocidos, incluyendo un
  pasillo donde la respuesta tail-aware difiere de la ingenua.
- **Voronoi**: reparto esperado en tableros conocidos, incluyendo empate de
  distancia resuelto por longitud.
- **Evaluación**: la salvaguarda de hambre dispara cuando `salud <= d + 2`.
- **Filtros duros**: el filtro de head-to-head rechaza la casilla adyacente
  a un rival de igual longitud cuando existe alternativa.

### Pruebas contra la URL desplegada

El CLI oficial de Battlesnake corre el motor del juego localmente y llama a
la URL por HTTP real. Es la prueba de integración de extremo a extremo, y
la única forma de medir latencia de red antes de registrar la serpiente.

```bash
# humo: sobrevive sola, sin movimientos ilegales ni timeouts
battlesnake play -W 11 -H 11 -g solo -v --url https://<app>.fly.dev

# duelo: dos instancias de la misma URL
battlesnake play -W 11 -H 11 -g standard -v \
  --name a --url https://<app>.fly.dev \
  --name b --url https://<app>.fly.dev

# FFA: cuatro instancias
battlesnake play -W 11 -H 11 -g standard -v \
  --name a --url https://<app>.fly.dev \
  --name b --url https://<app>.fly.dev \
  --name c --url https://<app>.fly.dev \
  --name d --url https://<app>.fly.dev
```

**Salvedad sobre la latencia medida.** El CLI corre en la máquina de quien
lo ejecuta, así que el round-trip observado es máquina-local → Fly.io, no
motor-oficial → Fly.io. Sirve como cota — un timeout desde la laptop
garantiza timeouts desde el motor oficial — pero no es la cifra definitiva.
`SEARCH_BUDGET_MS` se fija con margen sobre lo que el CLI muestre, y se
revisa tras las primeras partidas reales en la plataforma.

### Pendiente antes de competir

Fecha límite de registro: **2026-09-16**. En orden de prioridad:

1. Humo con el CLI en modo `solo` contra la URL desplegada: cero
   movimientos ilegales, cero timeouts. Sin esto no hay serpiente.
2. Medir `nodos/segundo` en la máquina desplegada; decidir `shared` vs
   `performance`. Fijar `SEARCH_BUDGET_MS` con margen sobre el RTT del CLI.
3. Arena ≥500 partidas contra el baseline de profundidad 0. Confirmar el
   ≥60% y verificar cero muertes mutuas voluntarias.
4. Duelo y FFA con el CLI contra la propia URL, para ver el comportamiento
   real bajo carga de red en vez de en el arena local.
5. Afinar pesos contra al menos una serpiente pública fuerte, no solo contra
   el baseline interno. El 69.2% preliminar es una señal de dirección, no
   una medida de competitividad de torneo.
6. Probar explícitamente el caso de reflexión horizontal de §7.

Los puntos 5 y 6 son los primeros que se recortan si el tiempo no alcanza.

## 12. Despliegue

`fly.toml` con `min_machines_running = 1` y el puerto interno que
`index.js` expone. Despliegue por `fly deploy`. Sin variables de entorno ni
secretos — Sneaker no depende de configuración externa.

Tras cada despliegue, el humo del CLI en modo `solo` (§11) contra la URL
antes de dar la versión por buena. Es un comando y tarda segundos.

## 13. Fuera de alcance

Excluido deliberadamente:

- **Tail-chasing como comportamiento explícito.** Emerge del flood fill
  tail-aware: la casilla de la propia cola es la de mayor espacio alcanzable,
  así que la evaluación la prefiere sin ayuda. Codificarlo aparte crearía una
  segunda fuente de verdad capaz de contradecir a la primera.
- **Término de desempate en la evaluación.** Ver §7: la versión propuesta
  era un no-op, y el riesgo que pretendía cubrir es marginal.
- **Un segundo simulador "rápido" junto al arena.** Ver §3.
- **Llamadas a APIs de IA en tiempo de decisión.** Ver §2. El afinado
  offline asistido por IA no es una excepción: el artefacto desplegado sigue
  siendo aritmética pura sin red.
- Rulesets royale, wrapped, constrictor. Solo estándar.
- Zonas de peligro (hazard sauce).
- Estado persistente entre turnos o partidas.
- Modelado de oponentes por nombre o historial.
- Aprendizaje automático de cualquier tipo en tiempo de ejecución.
- Tableros de tamaño distinto a 11x11 como objetivo — aunque las dimensiones
  se leen del payload, así que otros tamaños funcionan sin ser optimizados.
