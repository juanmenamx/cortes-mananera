# Cortes de la conferencia

Proyecto nuevo e independiente de `transcriptor-mananera`. Sigue una cadena de clips de 30 segundos, transcribe cada uno y, al cerrar un bloque, junta esos videos en un solo mp4.

## Cómo se leen las ligas

Una liga como esta:

`https://pmedia.efinf.com/A9U3zr6f/17/msc/HDMI1-288-20260929102200.mp4`

se separa así:

- carpeta: `https://pmedia.efinf.com/A9U3zr6f/17/msc/`
- prefijo fijo: `HDMI1-288-`
- hora de inicio: `20260929102200` (29 sep 2026, 10:22:00)
- extensión: `.mp4`

La siguiente liga suma 30 segundos a esa hora: `HDMI1-288-20260929102230.mp4`. Si el servidor responde con video, se descarga. Si responde que el clip no existe, se reintenta hasta un minuto después de que ese tramo debió terminar. Si para entonces no aparece, la generación se considera terminada.

Cada archivo dura un poco más de 30 segundos y se empalma con el siguiente. Se usan los primeros 30 segundos y se parten en tramos de 8 segundos (el último queda de 6). La transcripción avanza tramo por tramo, y al cerrar un bloque el video incluye solo esos tramos.

## Uso

1. Doble clic en `start.bat`.
2. Abre http://localhost:4311.
3. Pega la liga del primer clip y pulsa **Iniciar**.
4. **Nuevo bloque** junta los clips acumulados en un mp4 y redacta el texto para WhatsApp.
5. **Detener** cierra la captura y corta el tramo que haya quedado abierto.

Las credenciales se leen, si no hay `.env` propio, del `.env` de `transcriptor-mananera` o de `news-notas-ai`. No hace falta copiarlas. El puerto 4310 de ese otro proyecto no se reutiliza.

`ffmpeg.exe` se busca en `..\youtube-portable\bin\ffmpeg.exe`.
