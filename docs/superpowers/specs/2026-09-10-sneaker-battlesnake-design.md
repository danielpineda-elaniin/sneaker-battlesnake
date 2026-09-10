# Sneaker — Diseño Técnico

Fecha: 2026-09-10
Estado: aprobado para plan de implementación

## 1. Objetivo

Motor de decisión para Battlesnake llamado **Sneaker**. Heurístico espacial
envuelto en búsqueda con profundidad iterativa. Sin redes neuronales. Sin
estado persistente. Desplegado en Cloudflare Workers.

Dos escenarios de competencia:

- **FFA**: 4 serpientes, tablero 11x11, ruleset estándar.
- **Duel King**: 1v1, mismo tablero y ruleset.

### Criterios de éxito

1. Cero muertes por inanición y cero muertes por movimiento ilegal.
2. Cero timeouts. Siempre devuelve un movimiento dentro del presupuesto.
3. En el arena local, el vector de pesos afinado gana ≥60% de partidas
   contra un baseline de profundidad 0 (heurística pura, sin búsqueda).
4. Profundidad alcanzada: ≥4 en duelo, ≥2 en FFA de 4, en el 90% de turnos.

## 2. Restricciones

### Presupuesto de tiempo

Battlesnake otorga 500ms por movimiento. Reparto:

| Concepto | ms |
|---|---|
| Round-trip de red + parseo | ~100 (reservado) |
| Búsqueda | 350 (corte duro) |
| Serialización + margen | 50 |

La búsqueda consulta el reloj en cada nodo y aborta al cruzar el deadline,
descartando la profundidad parcial en curso.

### Cloudflare Workers

El límite de CPU por invocación se declara explícitamente en
`wrangler.toml` (`limits.cpu_ms = 400`). **El plan gratuito limita a 10ms de
CPU, lo cual es inviable para este diseño** — requiere plan de pago. Esto se
verifica antes de la primera implementación de la búsqueda; si el plan de
pago no está disponible, el diseño degrada a profundidad 0 (la heurística
pura sigue siendo funcional y compite razonablemente).

### Sin estado

Todo movimiento se computa exclusivamente desde el payload de la petición.
Sin KV, sin Durable Objects, sin caché entre turnos. Esto mantiene el
despliegue en el edge trivial y elimina una clase entera de bugs.

## 3. Módulos

```
src/
  index.js     handlers HTTP
  board.js     parseo, grilla de ocupación, simulación de turno
  space.js     flood fill tail-aware, Voronoi BFS
  eval.js      función de evaluación
  weights.js   vectores de peso por modo
  search.js    profundidad iterativa, alpha-beta paranoico
test/
  arena.js     runner de partidas locales para afinar pesos
  *.test.js    pruebas unitarias (node:test)
```

Wrangler empaqueta con esbuild, así que multi-archivo no tiene costo en
despliegue. Sigue siendo un `wrangler deploy`.

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

La grilla resultante `freeAt[x][y]` — 0 para casillas vacías, `n - i` para
ocupadas — es la entrada compartida de flood fill y Voronoi.

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

Dos decisiones deliberadas aquí:

**La comida es un peso, no un filtro.** En el diseño original la comida era
el quinto paso secuencial, lo que significaba que solo podía ganar cuando
todos los demás criterios empataban. Con salud al 10% y la comida en una
dirección de bajo Voronoi, esa arquitectura mata de hambre a la serpiente.
Como término ponderado, la urgencia escala de forma continua y compite de
verdad contra el control territorial.

**`HUNGER_OVERRIDE = 100` es una salvaguarda dura.** Si la salud no alcanza
para llegar a la comida más cercana con dos turnos de margen, comer se vuelve
dominante. La inanición es la derrota más evitable del juego.

El valor 100 no es arbitrario: los demás términos están acotados a 0..1 y sus
pesos suman menos de 9 en ambos vectores, así que `food × 100` supera
cualquier combinación posible de los otros criterios por un margen amplio.
Si los pesos se afinan al alza en el arena, esta relación debe reverificarse.

**El crecimiento temprano se ata a la ventaja de longitud, no al número de
turno.** Mientras no seamos estrictamente los más largos, la comida pesa más;
una vez que dominamos en longitud, el peso cae y priorizamos el espacio.

### Vectores de peso

```js
export const WEIGHTS = {
  ffa:  { space: 3.0, terr: 2.0, len: 1.0, center: 0.5, food: 1.5 },
  duel: { space: 3.0, terr: 3.5, len: 1.5, center: 0.8, food: 1.0 },
};
```

Valores iniciales, destinados a ser afinados por el arena. El modo se
selecciona por `board.snakes.length` — 2 serpientes vivas → `duel`, más →
`ffa`.

Los modos son vectores de peso, no ramas de código. Una sola ruta de
ejecución, diffeable y afinable por búsqueda en rejilla offline.

**El centro se premia, no se penaliza.** El diseño original prefería bordes y
anillos exteriores. Está invertido: un borde reduce las salidas de 4 a 3, una
esquina a 2. La maniobrabilidad del centro es exactamente lo que mantiene
viva a una serpiente evasiva. El riesgo de head-to-head en el centro lo
gestionan los filtros de combate, no el posicionamiento.

## 7. Búsqueda

### Profundidad iterativa

```
findMove(gameState):
  deadline = now + 350ms
  legales = movimientos no suicidas
  si legales vacío → cadena de respaldo
  mejor = elección heurística de profundidad 0   # siempre disponible
  para profundidad = 1, 2, 3, ...:
    intenta:
      mejor = alphabeta(estado, profundidad, -inf, +inf, deadline).move
    captura Timeout:
      rompe                                       # descarta nivel parcial
  devuelve mejor
```

La profundidad iterativa resuelve el problema del factor de ramificación sin
configuración manual: en duelo la búsqueda llega a profundidad 5-6, en FFA de
4 llega a 2-3, con el mismo código y el mismo presupuesto. El diseño original
requería cambiar de "marcha" manualmente según el número de serpientes; aquí
la profundidad se autoajusta.

Efecto secundario útil: `profundidad = 0` es exactamente la serpiente
heurística pura. Sirve de baseline de referencia en el arena y de respaldo
en producción.

### Modelo paranoico

Battlesnake es de movimiento simultáneo, lo que no es minimax puro. La
aproximación práctica: Sneaker mueve primero, los oponentes responden.

Todos los oponentes se colapsan en un único jugador minimizante que elige el
movimiento conjunto que peor deja a Sneaker. Es pesimista — asume
coordinación que no existe — pero errar hacia la supervivencia es el sesgo
correcto para una serpiente evasiva.

Poda alpha-beta estándar sobre este árbol de dos jugadores.

Aunque Sneaker mueva "primero" en el modelo secuencial, la resolución de
head-to-head se evalúa en el paso de resolución del turno, no tratando las
cabezas rivales como estáticas. Un choque frontal contra un rival igual o más
largo es una eliminación, y la búsqueda debe verla.

### Filtro de proximidad

Un oponente entra al árbol solo si
`manhattan(nuestraCabeza, suCabeza) <= 2 * profundidad + 2`. Fuera de ese
radio no puede alcanzarnos dentro del horizonte de búsqueda, y se trata como
obstáculo estático (su cuerpo permanece, no se mueve).

Esto colapsa un FFA de 4 a una búsqueda de 2 jugadores la mayor parte del
tiempo. Es la diferencia entre profundidad 2 y profundidad 4 en la misma
ventana de tiempo, sin pérdida de precisión relevante.

### Filtros duros previos

Antes de puntuar, se eliminan movimientos:

1. Fuera del tablero.
2. Contra un segmento corporal que no se vacía a tiempo.
3. Head-to-head perdedor: casilla adyacente a la cabeza de un rival de
   longitud igual o mayor. Un rival adyacente a comida se trata como si ya
   hubiera crecido.
4. Flood fill resultante `< length - 1`.

El filtro de head-to-head se mueve aquí, junto a la supervivencia. En el
diseño original iba después del scoring de Voronoi, lo que producía un
conflicto sin resolución: Voronoi elegía un movimiento que el filtro de
combate luego prohibía, y el pipeline no definía qué hacer. Como filtro
previo, el conflicto desaparece.

## 8. Cadena de respaldo

Sneaker nunca devuelve un error ni omite un movimiento:

1. Mejor movimiento de la búsqueda.
2. Mejor heurístico de profundidad 0 entre los legales.
3. Cualquier movimiento no inmediatamente fatal.
4. Cualquier movimiento dentro del tablero.
5. `"up"`.

Cualquier excepción no capturada dentro del handler cae a esta cadena. Un
movimiento malo pierde una partida; un timeout o un 500 la pierde igual pero
además oculta el bug.

## 9. Endpoints HTTP

| Ruta | Método | Respuesta |
|---|---|---|
| `/` | GET | metadatos de apariencia (`apiversion`, `author`, `color`, `head`, `tail`) |
| `/start` | POST | 200, cuerpo vacío |
| `/move` | POST | `{ "move": "up\|down\|left\|right", "shout": string }` |
| `/end` | POST | 200, cuerpo vacío |

`/start` y `/end` no guardan nada — existen porque el protocolo los exige.

## 10. Arena y pruebas

### Arena

`test/arena.js` reutiliza la simulación de turno de `board.js` para correr
partidas completas localmente. Como la búsqueda ya necesita simular turnos,
el arena es casi gratis una vez que `board.js` existe — no requiere el CLI
oficial ni dependencias externas.

```bash
node test/arena.js --games 200 --a ffa --b experimental
```

Reporta: tasa de victoria, turnos de supervivencia promedio, y desglose de
causas de muerte (pared, cuerpo, head-to-head, inanición).

Esto es lo que convierte el afinado de pesos en medición en vez de
adivinanza, y es la razón por la que se construye antes que la búsqueda. Sin
arena no hay forma de saber si un cambio de pesos mejoró o empeoró la
serpiente.

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

## 11. Despliegue

`wrangler.toml` con `limits.cpu_ms = 400`. Despliegue por
`wrangler deploy`. Sin variables de entorno ni secretos — Sneaker no depende
de configuración externa.

## 12. Fuera de alcance

Excluido deliberadamente:

- Rulesets royale, wrapped, constrictor. Solo estándar.
- Zonas de peligro (hazard sauce).
- Estado persistente entre turnos o partidas.
- Modelado de oponentes por nombre o historial.
- Aprendizaje automático de cualquier tipo.
- Tableros de tamaño distinto a 11x11 como objetivo — aunque las dimensiones
  se leen del payload, así que otros tamaños funcionan sin ser optimizados.
