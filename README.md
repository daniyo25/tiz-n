# Dani Launcher

Launcher personal para TVs Samsung (Tizen) que funciona como módulo de [TizenBrew](https://github.com/reisxd/TizenBrew). Tiene filas de accesos por categorías con los logos de las apps, reloj, tiempo y widgets. Se maneja con el mando y se puede editar desde el móvil.

![Vista previa](preview.png)

## Instalación en la TV

1. Instala TizenBrew siguiendo la guía.
2. Abre TizenBrew y pulsa el botón **verde** para añadir un módulo.
3. Escribe `gh/daniyo25/tiz-n` y confirma.
4. Abre "Dani Launcher" en la lista de módulos.
5. Opcional: en Ajustes (botón **azul**), activa "Abrir al iniciar TizenBrew".

jsDelivr guarda en caché las ramas hasta 12 horas. Para probar una versión al momento, añade el módulo con el commit: `gh/daniyo25/tiz-n@<commit>`.

## Mando

| Tecla | Acción |
| --- | --- |
| Flechas | Moverse por los accesos (izquierda/derecha dentro de una fila, arriba/abajo entre filas) |
| Arriba desde la primera fila | Menú de arriba: Editar, Ajustes, Recargar y el tiempo |
| Derecha desde el final de una fila | Columna de widgets: previsión y noticias, con arriba/abajo |
| OK | Abrir el acceso, la opción del menú, el tiempo completo o la noticia |
| Volver | Cerrar el panel abierto o volver a TizenBrew |

En la noticia abierta, izquierda/derecha pasan a la siguiente y arriba/abajo desplazan el texto. Editar muestra, con su icono, los accesos del launcher (OK para quitarlos, moverlos de fila o de sitio), los widgets (OK o ←→ para cambiarlos: previsión, fuente de noticias y Home Assistant) y las apps instaladas (OK para añadirlas); izquierda y derecha saltan de 10 en 10. Ajustes tiene estilo (Apple TV o clásico), color, tamaño, tipografía, animaciones, fuente de noticias, modo reposo, autoarranque y la dirección del editor.

Los logos de las apps ocupan toda la tarjeta cuando tienen fondo liso: la tarjeta toma el color del borde del logo, sin estirarlo. Si prefieres una imagen panorámica propia, ponla en el campo `banner` del acceso (o en «Imagen panorámica» del editor del móvil).

Los botones de colores siguen funcionando como atajos (rojo recargar, verde tamaño, amarillo apps, azul ajustes), pero no hacen falta.

## Editar desde el móvil

En Ajustes (botón azul) aparecen la dirección del editor y un PIN, por ejemplo `http://192.168.1.50:8091/editor`. Ábrela en el navegador del móvil, con el móvil en la misma wifi que la tele. Desde ahí puedes:

- Cambiar el saludo, el fondo y la ciudad del tiempo.
- Ver la lista de apps instaladas en la tele, con su logo, y añadirlas o quitarlas del launcher con un toque. Se guarda al momento en la fila que elijas.
- Añadir, quitar y ordenar filas y accesos. Las apps instaladas aparecen como sugerencias al escribir el ID.

Al guardar, la tele se actualiza sola en unos segundos (si no tiene un panel abierto ni está en reposo). El móvil recuerda el PIN, pero el PIN cambia cada vez que TizenBrew arranca el servicio. "Restablecer" vuelve a `app/config.json`.

### Enviar a la tele

En el editor del móvil, «Enviar a la tele» sube una foto, un vídeo o un audio del móvil (o un enlace directo a uno) y la tele lo abre a pantalla completa. Con un enlace de YouTube abre la app de YouTube con ese vídeo. Con el vídeo: OK pausa, ←→ salta 10 s y Volver cierra. En la tele solo se guarda lo último enviado, en `/home/owner/share/dani-launcher-media/`.

### Home Assistant y Spotify

- **Home Assistant:** en el editor del móvil pon la dirección y un token de larga duración, pulsa «Cargar entidades», marca las que quieras y Guardar. En la tele, OK sobre una luz, enchufe, ventilador, persiana, escena o script la activa.
- **Spotify:** crea una app en developer.spotify.com con la Redirect URI que indica el editor, pega su Client ID, inicia sesión y pega la dirección final. El widget muestra lo que suena; OK pausa o reanuda y → pasa de canción (necesita Premium para controlarlo).

### Logos

El servicio busca en la carpeta de cada app una imagen panorámica (logo o banner) y, si no hay, el icono. Para ver qué encuentra para una app: `http://<IP de la tele>:8091/icon?id=<id de la app>&debug=1`.

## Personalizar a mano

La configuración por defecto está en `app/config.json`. Lo que guardes desde la tele o el móvil se guarda en la tele y tiene prioridad sobre este archivo.

- `title`: el saludo de arriba.
- `background`: URL directa de una imagen de fondo (que acabe en .jpg, .png…, no la página donde aparece; si no es una imagen, la tele lo avisa abajo a la derecha). Si lo dejas vacío, el fondo es negro puro (en OLED, esos píxeles se apagan).
- `weather`: ciudad y coordenadas. El tiempo sale de Open-Meteo, que no necesita clave.
- `theme`: `style` (`tvos` para el estilo Apple TV, `classic` para el original), `accent` (color), `size` (`s`, `m` o `l`), `font` (`sans`, `serif` o `mono`) y `anim` (`false` quita las animaciones).
- `screensaver.minutes`: minutos sin tocar el mando hasta el modo reposo. `0` lo desactiva. En reposo solo queda un reloj tenue que cambia de sitio cada minuto, para evitar marcas en la OLED.
- `autolaunch`: si el launcher se abre al iniciar TizenBrew.
- `widgets`:
  - `forecast`: previsión de los próximos tres días.
  - `news`: titulares de un feed RSS (`title` y `url`).
  - `homeassistant`: `url` de tu Home Assistant, un token de acceso de larga duración (`token`) y las `entities` que quieres ver, por ejemplo `["sensor.salon_temperatura"]`.
- `rows`: filas con `title` y `tiles`. Cada acceso tiene `name`, `color`, opcionalmente `icon` (URL de un logo) y uno de estos tipos:
  - `tvapp`: una app instalada en la TV. `id` es su ID de Tizen (botón amarillo). El logo se toma de la propia app.
  - `module`: un módulo de TizenBrew. `id` es su nombre completo, por ejemplo `gh/reisxd/TizenTube`.
  - `url`: una web. `id` es la URL.

## Cómo funciona

La página del launcher no tiene permiso para abrir otras apps, y la API local de la TV responde 401. Por eso el módulo incluye un servicio que TizenBrew arranca junto al launcher. El servicio tiene acceso a `tizen.application` y escucha en el puerto 8091:

- Desde la propia tele: abre apps, lee sus iconos y descarga noticias y datos de Home Assistant (que no permiten CORS).
- Desde la red local: sirve el editor del móvil. Para guardar cambios pide el PIN.

El código del servicio está en `service/src/`. TizenBrew solo admite un archivo de servicio, así que después de editarlo hay que generar `service/service.js` con:

```sh
node tools/build-service.js
```
