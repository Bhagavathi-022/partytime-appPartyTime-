# PartyTime

Watch together, wherever you are. Pick any movie, series or documentary, open a room, share the link.
PartyTime checks that **everyone in the room has a streaming service that carries the title**, sends you
all to that platform, and counts you in so you press play at the same moment. Free YouTube videos play
inside the room, kept in sync. Voice chat, text chat, reactions and a "watch next" queue are built in.

## What you need

1. **Node.js 18 or newer** (https://nodejs.org, choose "LTS"). There is nothing else to install.
2. **A movie data key** (free). You need at least one:
   - **TMDB key (recommended).** Required for the "where can we watch this" check, series and documentary
     browsing, and trending lists. Sign up at https://www.themoviedb.org, then Settings > API > request a key.
     Copy the **API Key (v3 auth)**. If themoviedb.org will not open on your network, sign up through
     mobile data or a VPN once. The key itself works from anywhere afterwards, and this app fetches posters
     through its own server, so your viewers do not need to reach TMDB.
   - **OMDb key.** Search and details only. No "where to watch" check. Get one at
     https://www.omdbapi.com/apikey.aspx and click the activation link in the email.

## Run it on your computer

1. Unzip the folder and open a terminal inside it.
2. Copy `.env.example` to `.env` and paste your key after `TMDB_API_KEY=` (and/or `OMDB_API_KEY=`).
3. Run `npm start`.
4. Open http://localhost:3000.

To try it with a second device on the same Wi-Fi, open `http://YOUR-COMPUTER-IP:3000` on that device.
Chat, sync and rooms work. **Voice chat needs https** (browsers block the microphone on plain http, except
on localhost), so for voice across devices use the online version below.

## Put it online (gets you a real link that works on any device)

Any host that runs Node works. This is the Render route (free plan):

1. Create a GitHub account if you do not have one, make a new repository, and upload this folder
   (do not upload your `.env` file).
2. Create an account at https://render.com and choose **New > Blueprint**, then pick that repository.
   Render reads `render.yaml` for you.
3. When asked, paste `TMDB_API_KEY` (and optionally `OMDB_API_KEY`). Click **Apply**.
4. After the first deploy finishes, Render shows your address, like `https://partytime-abcd.onrender.com`.
   That is your link. Open it on your laptop and your phone.

Notes for the free plan: the app goes to sleep after about 15 minutes with nobody using it and takes up
to a minute to wake, and live rooms are kept in memory, so a restart ends them. Saved "My List" entries
live in `data/db.json`, which free hosting wipes on restart. A paid plan with a disk keeps them.

Docker works too (`docker build -t partytime . && docker run -p 3000:3000 --env-file .env partytime`).

## How a watch party works

1. One person creates a room (from a title page or the **Create Room** button) and shares the invite link
   or the 6-character code. Everyone else opens it and enters a name.
2. The host picks a title. PartyTime looks up where it streams in the room's country.
3. Everyone ticks the services they have. The room shows one of these:
   - **Free** (for example on YouTube): everyone can watch. No subscription needed.
   - **Ready**: one service carries it and everyone has it. The host can start.
   - **Not everyone can watch**: shows who is missing which service. The host cannot start.
   - **Not streaming anywhere**: a clear message, with the option to pick another title.
4. The host taps start. Everyone gets an **Open Netflix** (or whichever platform) link, finds the title,
   and taps **I'm ready**. When all are ready a countdown runs, then **PLAY NOW**.
5. A shared clock keeps running, and the host's pause and resume show up on everyone's screen.
6. Voice: tap **Join voice** in the sidebar and allow the microphone.

## Honest limits

- **Netflix, Prime Video, Hotstar and similar do not allow websites to control their players.** PartyTime
  cannot press play for you. It gets everyone to the right place and counts you down together, so sync
  depends on each person pressing play at the countdown, and on pausing when the host pauses. Only
  YouTube videos are embedded and synced automatically.
- **"Every movie ever released"** means everything in TMDB or OMDb, which covers well over a million
  titles. Very obscure or unreleased titles may be missing.
- **Where-to-watch data** comes from JustWatch through TMDB. It is good but can lag behind the services,
  and it is per country, so pick the country everyone is watching from.
- **Voice chat** is peer to peer. It works for small groups on most networks. On strict networks you may
  need a TURN server (set `TURN_URL`, `TURN_USER`, `TURN_PASS`). Rooms hold up to 12 people.
- **Accounts:** there are none. Your name, "My List" and services are tied to the browser you use.
  Anyone with a room code can join that room.

## Tests

`npm test` runs 49 backend checks with stand-in movie services (no keys needed). `test/e2e.js` drives two real
browsers through a whole party, including voice, and needs Playwright.

## Credits

Movie data and artwork: TMDB or OMDb. Where-to-watch data: JustWatch, via TMDB. This product uses the TMDB
API but is not endorsed or certified by TMDB.
