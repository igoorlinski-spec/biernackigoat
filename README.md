# Hextech Stopwatch - Instrukcja Wdrożenia (Deployment Guide)

Gra oparta jest na stosie: **Node.js + Express + Socket.io + SQLite**. Baza danych tworzy się automatycznie na serwerze podczas pierwszego uruchomienia.

Oto instrukcja jak hostować tę aplikację **całkowicie za darmo** w chmurze!

---

## Opcja A: Wdrożenie na Render (Zalecane dla produkcji)

Render.com oferuje darmowy hosting serwisów internetowych z obsługą WebSockets.

1. **Stwórz repozytorium GitHub**:
   - Prześlij wszystkie pliki tego projektu (`server.js`, `package.json`, katalog `public/`) do nowego, publicznego lub prywatnego repozytorium na swoim koncie GitHub.
2. **Zarejestruj się na Render**:
   - Wejdź na [render.com](https://render.com/) i załóż darmowe konto.
3. **Stwórz nowy Web Service**:
   - W panelu Render kliknij **New +** -> **Web Service**.
   - Połącz swoje konto GitHub i wybierz repozytorium z grą.
4. **Skonfiguruj ustawienia Web Service**:
   - **Name**: `hextech-stopwatch` (lub dowolna inna nazwa).
   - **Region**: Wybierz najbliższy (np. Frankfurt / Europe).
   - **Branch**: `main`.
   - **Runtime**: `Node`.
   - **Build Command**: `npm install`.
   - **Start Command**: `npm start` (lub `node server.js`).
   - **Instance Type**: `Free`.
5. **Wdrożenie**:
   - Kliknij **Deploy Web Service**. Render pobierze kod, zainstaluje biblioteki i uruchomi serwer.
   - Po zakończeniu otrzymasz adres URL swojej gry (np. `https://hextech-stopwatch.onrender.com`), pod którym gracze mogą grać wspólnie w czasie rzeczywistym!

*Uwaga: Na darmowym serwerze Render instancja może przechodzić w stan uśpienia (spin-down) po 15 minutach bezczynności. Pierwsze wejście na stronę po uśpieniu może potrwać około 50 sekund.*

---

## Opcja B: Szybki hosting na Glitch (Idealny do testów na żywo)

Glitch.com pozwala na uruchomienie aplikacji Node.js bezpośrednio w przeglądarce w kilka sekund.

1. **Zarejestruj się na Glitch**:
   - Wejdź na [glitch.com](https://glitch.com/) i zaloguj się.
2. **Utwórz nowy projekt**:
   - Kliknij **New Project** -> **Import from GitHub** LUB wybierz **glitch-hello-node** i zastąp w nim pliki.
   - Możesz też zaimportować bezpośrednio kod z repozytorium GitHub.
3. **Ustaw pliki w edytorze Glitch**:
   - Upewnij się, że plik `package.json` ma odpowiednie zależności. Glitch automatycznie pobierze pakiety.
   - Wklej zawartość `server.js` do głównego pliku projektu.
   - Utwórz folder `public` i wklej tam kod z `index.html`.
4. **Gotowe!**:
   - Kliknij przycisk **Share** -> **Live Site**, aby otrzymać link dla graczy. Gra natychmiast działa i automatycznie zapisuje bazę danych w chmurze!
