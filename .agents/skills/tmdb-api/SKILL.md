---
name: tmdb-api
description: Use when working with The Movie Database (TMDB) API v3 — fetching movie, TV series, season, episode, or person data; building search or discovery features; handling authentication, ratings, watchlists, or watch providers; using append_to_response to batch requests; or understanding which endpoints exist and what parameters they accept.
---

# TMDB API v3

TMDB's REST API is versioned at `/3/`. All endpoints require `?api_key=YOUR_KEY` or an `Authorization: Bearer TOKEN` header. Base URL: `https://api.themoviedb.org`.

## Authentication

Three session types exist, each with different write access:

| Type | Creation | Write access |
|------|----------|--------------|
| User session | Token → login → session flow | Ratings, watchlist, favorites |
| Guest session | `GET /3/authentication/guest_session/new` | Ratings only |
| API key only | None needed | Read-only |

**User session flow:**
1. `GET /3/authentication/token/new` — get a request token
2. Redirect user to `https://www.themoviedb.org/authenticate/{request_token}`
3. `POST /3/authentication/session/new` with `{ "request_token": "..." }` — exchange for session_id

Guest sessions expire after a period of inactivity and cannot access account endpoints.

## Common Parameters

`language` (BCP-47, e.g. `en-US`) applies to most endpoints and affects translated fields like `title`, `overview`, and `tagline`. `page` is 1-based; most paginated endpoints cap at 500 pages.

`append_to_response` accepts a comma-separated list of sub-resources (max 20) and applies **only** to detail endpoints:
- `GET /3/movie/{movie_id}`
- `GET /3/tv/{series_id}`
- `GET /3/tv/{series_id}/season/{season_number}`
- `GET /3/tv/{series_id}/season/{season_number}/episode/{episode_number}`
- `GET /3/person/{person_id}`

Example: `/3/movie/550?append_to_response=credits,videos,images` returns the movie detail with credits, videos, and images merged into one response, saving two round trips.

## Movies

### Movie Lists

| Endpoint | Description | Extra params |
|----------|-------------|--------------|
| `GET /3/movie/popular` | Popularity-ranked | `region` (ISO-3166-1) |
| `GET /3/movie/top_rated` | Highest rated | `region` |
| `GET /3/movie/now_playing` | In theatres | `region` |
| `GET /3/movie/upcoming` | Coming soon | `region` |
| `GET /3/movie/latest` | Most recently added | — |
| `GET /3/movie/changes` | Changed movie IDs | `start_date`, `end_date` |

### Movie Detail

`GET /3/movie/{movie_id}` — full metadata including `belongs_to_collection`, `budget`, `revenue`, `runtime`, `release_date`.

### Movie Sub-resources

| Endpoint | Returns |
|----------|---------|
| `/3/movie/{id}/credits` | Cast and crew |
| `/3/movie/{id}/images` | Posters, backdrops, logos |
| `/3/movie/{id}/videos` | Trailers, clips (YouTube/Vimeo) |
| `/3/movie/{id}/keywords` | Associated keywords |
| `/3/movie/{id}/recommendations` | Similar movies TMDB recommends |
| `/3/movie/{id}/similar` | Same genre/keywords |
| `/3/movie/{id}/release_dates` | Per-country release dates and certifications |
| `/3/movie/{id}/watch/providers` | Streaming/rent/buy availability by region |
| `/3/movie/{id}/alternative_titles` | Title variations by country |
| `/3/movie/{id}/translations` | Translated metadata |
| `/3/movie/{id}/reviews` | User reviews |
| `/3/movie/{id}/lists` | User lists containing this movie |
| `/3/movie/{id}/account_states` | Auth required — user's rating, watchlist, favorite status |
| `/3/movie/{id}/rating` | POST/DELETE — add or remove a rating |
| `/3/movie/{id}/external_ids` | IMDb, Wikidata, Facebook, Instagram, Twitter |

All of the above are also valid values for `append_to_response` on the movie detail endpoint.

### Images

`GET /3/movie/{id}/images` returns three arrays: `backdrops`, `posters`, `logos`. Each image object has `file_path`, `width`, `height`, `vote_average`, and `iso_639_1` (language tag, or `null` for untagged).

To get English images as fallback when querying in another language, add `include_image_language=en,null`. Using only `null` skips English-tagged images, which are often the most abundant.

## TV Series

### TV Lists

| Endpoint | Description | Extra params |
|----------|-------------|--------------|
| `GET /3/tv/popular` | Popularity-ranked | — |
| `GET /3/tv/top_rated` | Highest rated | — |
| `GET /3/tv/airing_today` | Airing today | `timezone` |
| `GET /3/tv/on_the_air` | Airing in next 7 days | `timezone` |
| `GET /3/tv/latest` | Most recently added | — |
| `GET /3/tv/changes` | Changed series IDs | `start_date`, `end_date` |

TV list endpoints do not accept a `region` parameter (unlike movie lists).

### Series Detail

`GET /3/tv/{series_id}` — includes `number_of_seasons`, `number_of_episodes`, `networks`, `created_by`, `last_air_date`, `next_episode_to_air`, `seasons` (summary array), `type`, and `status`.

### TV Sub-resources

| Endpoint | Returns |
|----------|---------|
| `/3/tv/{id}/credits` | Cast/crew for the **latest season only** |
| `/3/tv/{id}/aggregate_credits` | Cast/crew aggregated across **all seasons** |
| `/3/tv/{id}/images` | Posters, backdrops, logos |
| `/3/tv/{id}/videos` | Trailers, clips |
| `/3/tv/{id}/keywords` | Keywords |
| `/3/tv/{id}/recommendations` | Recommended series |
| `/3/tv/{id}/similar` | Similar series |
| `/3/tv/{id}/content_ratings` | Per-country content ratings (e.g. TV-MA) |
| `/3/tv/{id}/watch/providers` | Streaming availability by region |
| `/3/tv/{id}/alternative_titles` | Title variations |
| `/3/tv/{id}/translations` | Translated metadata |
| `/3/tv/{id}/reviews` | User reviews |
| `/3/tv/{id}/external_ids` | IMDb, TVDB, Wikidata, socials |
| `/3/tv/{id}/account_states` | Auth required — user's rating, watchlist, favorite |
| `/3/tv/{id}/rating` | POST/DELETE — add or remove a rating |
| `/3/tv/{id}/episode_groups` | Grouped episode orderings (e.g. DVD order) |
| `/3/tv/{id}/screened_theatrically` | Episodes that had a theatrical run |

`credits` vs `aggregate_credits`: use `aggregate_credits` when you need the full series cast list. `credits` only covers the latest season, so recurring characters from earlier seasons may be absent.

`aggregate_credits` returns a `roles` array per cast member (one entry per character/season) rather than a flat cast list. Sort client-side by `total_episode_count` to approximate series regulars.

Both `credits` and `aggregate_credits` are valid `append_to_response` values on the series detail endpoint.

### Seasons

`GET /3/tv/{series_id}/season/{season_number}` — full season detail including all episodes.

| Sub-resource | Returns |
|--------------|---------|
| `/season/{n}/credits` | Season-level cast/crew |
| `/season/{n}/aggregate_credits` | Aggregated across the season |
| `/season/{n}/images` | Season posters |
| `/season/{n}/videos` | Season trailers |
| `/season/{n}/translations` | Translated metadata |
| `/season/{n}/external_ids` | TVDB, TMDB IDs |
| `/season/{n}/watch/providers` | Season streaming availability |

Season 0 is the specials season when it exists.

### Episodes

`GET /3/tv/{series_id}/season/{season_number}/episode/{episode_number}` — full episode detail.

| Sub-resource | Returns |
|--------------|---------|
| `/episode/{n}/credits` | Episode cast/crew (guest stars included) |
| `/episode/{n}/images` | Still frames |
| `/episode/{n}/videos` | Clips |
| `/episode/{n}/translations` | Translated metadata |
| `/episode/{n}/external_ids` | IMDb, TVDB IDs |
| `/episode/{n}/rating` | POST/DELETE — episode rating |

## People

`GET /3/person/{person_id}` — biography, birthday, deathday, place of birth, `known_for_department`, `also_known_as`.

| Endpoint | Returns |
|----------|---------|
| `/3/person/{id}/movie_credits` | Movies as cast or crew |
| `/3/person/{id}/tv_credits` | TV series as cast or crew |
| `/3/person/{id}/combined_credits` | Both, with `media_type` field distinguishing them |
| `/3/person/{id}/images` | Profile photos |
| `/3/person/{id}/tagged_images` | Images tagged with this person |
| `/3/person/{id}/external_ids` | IMDb, TVDB, socials |
| `/3/person/{id}/translations` | Translated biography |
| `/3/person/popular` | Popularity-ranked people list |
| `/3/person/latest` | Most recently added |
| `/3/person/changes` | Changed person IDs |

All person sub-resources above are valid `append_to_response` values on the person detail endpoint.

## Search

| Endpoint | Searches | Extra params |
|----------|----------|--------------|
| `GET /3/search/movie` | Movies | `primary_release_year`, `year`, `region` |
| `GET /3/search/tv` | TV series | `first_air_date_year`, `year` |
| `GET /3/search/person` | People | — |
| `GET /3/search/multi` | Movies, TV, people in one call | — |
| `GET /3/search/collection` | Movie collections | — |
| `GET /3/search/company` | Production companies | — |
| `GET /3/search/keyword` | Keywords | — |

All search endpoints accept `query` (required), `language`, `page`, and `include_adult`.

`/3/search/multi` results include a `media_type` field (`"movie"`, `"tv"`, or `"person"`) to distinguish result types.

## Discover

Discover is a filtered browsing API — not keyword search. Results are sorted and filterable, not relevance-ranked.

### Movie Discover

`GET /3/discover/movie` key parameters:

| Parameter | Description |
|-----------|-------------|
| `sort_by` | `popularity.desc`, `vote_average.desc`, `revenue.desc`, `release_date.desc`, etc. |
| `with_genres` | Genre IDs — comma = AND, pipe = OR |
| `with_cast` | Person IDs — comma = AND, pipe = OR |
| `with_crew` | Person IDs |
| `with_people` | Cast or crew IDs |
| `with_companies` | Company IDs |
| `with_keywords` | Keyword IDs — comma = AND, pipe = OR |
| `without_genres` | Exclude by genre ID |
| `without_keywords` | Exclude by keyword ID |
| `primary_release_year` | Exact year |
| `primary_release_date.gte` / `.lte` | Date range |
| `release_date.gte` / `.lte` | Any release type date range |
| `vote_average.gte` / `.lte` | Score range |
| `vote_count.gte` / `.lte` | Minimum vote count (use with vote_average filters) |
| `with_runtime.gte` / `.lte` | Runtime in minutes |
| `region` | ISO-3166-1 — affects release date filtering |
| `certification` / `certification_country` | Filter by certification (e.g. R, PG-13) |
| `with_release_type` | Release type: 1=Premiere, 2=Limited, 3=Theatrical, 4=Digital, 5=Physical, 6=TV |
| `with_watch_providers` | Provider IDs — use with `watch_region` |
| `watch_region` | ISO-3166-1 — required for watch provider filtering |
| `with_watch_monetization_types` | `flatrate`, `free`, `ads`, `rent`, `buy` |
| `with_original_language` | ISO-639-1 language code |
| `with_origin_country` | ISO-3166-1 country code |
| `year` | Alias for `primary_release_year` |
| `include_adult` | Default false |
| `include_video` | Include video-only releases, default false |

### TV Discover

`GET /3/discover/tv` — same pattern, with TV-specific parameters:

| Parameter | Description |
|-----------|-------------|
| `sort_by` | `popularity.desc`, `vote_average.desc`, `first_air_date.desc`, etc. |
| `with_genres` | Genre IDs |
| `with_networks` | Network ID (integer, not comma-separated) |
| `with_status` | 0=Returning, 1=Planned, 2=In Production, 3=Ended, 4=Canceled, 5=Pilot |
| `with_type` | 0=Documentary, 1=News, 2=Miniseries, 3=Reality, 4=Scripted, 5=Talk Show, 6=Video |
| `first_air_date_year` | Exact first air year |
| `first_air_date.gte` / `.lte` | Date range |
| `air_date.gte` / `.lte` | Episode air date range |
| `timezone` | Used with air date filters |
| `screened_theatrically` | Boolean — only series with theatrical episodes |
| `include_null_first_air_dates` | Include series without a first air date |

## Trending

`GET /3/trending/{media_type}/{time_window}` — `media_type` is `movie`, `tv`, `person`, or `all`; `time_window` is `day` or `week`.

## Find by External ID

`GET /3/find/{external_id}?external_source=imdb_id` — look up a TMDB entity by an external identifier.

Supported `external_source` values: `imdb_id`, `tvdb_id`, `freebase_mid`, `freebase_id`, `tvrage_id`, `wikidata_id`, `facebook_id`, `instagram_id`, `twitter_id`.

Returns separate arrays: `movie_results`, `tv_results`, `tv_season_results`, `tv_episode_results`, `person_results`.

## Collections, Networks, Companies, Keywords

| Endpoint | Description |
|----------|-------------|
| `GET /3/collection/{id}` | Movie collection detail (e.g. Marvel Cinematic Universe) |
| `GET /3/collection/{id}/images` | Collection images |
| `GET /3/collection/{id}/translations` | Translated metadata |
| `GET /3/network/{id}` | Network detail (e.g. HBO) |
| `GET /3/network/{id}/images` | Network logos |
| `GET /3/network/{id}/alternative_names` | Network name aliases |
| `GET /3/company/{id}` | Production company detail |
| `GET /3/company/{id}/images` | Company logos |
| `GET /3/company/{id}/alternative_names` | Company name aliases |
| `GET /3/keyword/{id}` | Keyword detail |
| `GET /3/keyword/{id}/movies` | Movies tagged with this keyword |
| `GET /3/credit/{credit_id}` | Cast/crew credit detail by credit ID |

## Account & Watchlist (Auth Required)

All account endpoints require a valid `session_id` query parameter.

| Endpoint | Description |
|----------|-------------|
| `GET /3/account/{account_id}` | Account details |
| `POST /3/account/{account_id}/favorite` | Add/remove favorite |
| `POST /3/account/{account_id}/watchlist` | Add/remove watchlist entry |
| `GET /3/account/{account_id}/favorite/movies` | Favorite movies |
| `GET /3/account/{account_id}/favorite/tv` | Favorite TV series |
| `GET /3/account/{account_id}/watchlist/movies` | Watchlist movies |
| `GET /3/account/{account_id}/watchlist/tv` | Watchlist TV series |
| `GET /3/account/{account_id}/rated/movies` | Rated movies |
| `GET /3/account/{account_id}/rated/tv` | Rated TV series |
| `GET /3/account/{account_id}/rated/tv/episodes` | Rated episodes |
| `GET /3/account/{account_id}/lists` | User-created lists |

Guest session ratings use `GET /3/guest_session/{guest_session_id}/rated/movies` (and `/tv`, `/tv/episodes`).

## Lists (v3)

| Endpoint | Description |
|----------|-------------|
| `POST /3/list` | Create a list |
| `GET /3/list/{list_id}` | List detail and items |
| `POST /3/list/{list_id}/add_item` | Add a movie |
| `POST /3/list/{list_id}/remove_item` | Remove a movie |
| `POST /3/list/{list_id}/clear` | Remove all items |
| `DELETE /3/list/{list_id}` | Delete the list |
| `GET /3/list/{list_id}/item_status` | Check if a movie is in the list |

## Configuration & Reference Data

| Endpoint | Returns |
|----------|---------|
| `GET /3/configuration` | Image base URLs, available sizes, change keys |
| `GET /3/configuration/countries` | Country list with ISO codes |
| `GET /3/configuration/languages` | Language list with ISO codes |
| `GET /3/configuration/jobs` | Department and job name list |
| `GET /3/configuration/primary_translations` | Supported translation locales |
| `GET /3/configuration/timezones` | Timezone list |
| `GET /3/genre/movie/list` | Movie genre IDs and names |
| `GET /3/genre/tv/list` | TV genre IDs and names |
| `GET /3/certification/movie/list` | Movie certifications by country |
| `GET /3/certification/tv/list` | TV certifications by country |
| `GET /3/watch/providers/movie` | Available movie streaming providers |
| `GET /3/watch/providers/tv` | Available TV streaming providers |
| `GET /3/watch/providers/regions` | Regions where watch providers operate |

## Images

Image URLs are assembled from the configuration endpoint: `secure_base_url + size + file_path`.

Common sizes: `w45`, `w92`, `w154`, `w185`, `w300`, `w342`, `w500`, `w780`, `w1280`, `original`. Not all sizes apply to all image types — use the `poster_sizes`, `backdrop_sizes`, `profile_sizes`, etc. arrays from the configuration endpoint to know what's valid.

## Rate Limits & Errors

TMDB allows roughly 40 requests per second. Exceeding the limit returns `429 Too Many Requests`. No official rate-limit headers are documented; back off and retry on 429.

| Status | Meaning |
|--------|---------|
| `401` | Invalid API key or missing authentication |
| `404` | Resource not found |
| `422` | Validation error (check request body) |
| `429` | Rate limit exceeded — back off and retry |

Error responses include a `status_code` (TMDB's internal code) and `status_message` in the JSON body alongside the HTTP status.
