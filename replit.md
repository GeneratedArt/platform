# GeneratedArt Jekyll Site

## Overview
A Jekyll static site for GeneratedArt — an organization focused on the intersection of generative art, technology, and real-world data.

## Tech Stack
- **Ruby 3.2.2** with Bundler
- **Jekyll 3.8.7** — static site generator
- **Liquid** — templating engine
- **Bootstrap, jQuery, Owl Carousel, Fancybox, Isotope** — frontend libraries

## Plugins
- jekyll-feed
- jekyll-paginate-v2
- jekyll-archives
- jekyll-tagging

## Project Structure
- `_config.yml` — Jekyll configuration
- `_layouts/` — HTML layout templates
- `_includes/` — Reusable HTML snippets (header, footer, etc.)
- `_data/` — YAML data files (navigation, etc.)
- `assets/` — CSS, JS, images, fonts
- `_site/` — Built output (generated, not committed)
- Root HTML files: `index.html`, `about.html`, `blog.html`, `contact.html`, `services.html`

## Development
- Run: `bundle exec jekyll serve --host 0.0.0.0 --port 5000 --no-watch`
- Workflow: "Start application" on port 5000

## Deployment
- Type: Static site
- Build command: `bundle exec jekyll build`
- Public directory: `_site`

## Ruby 3.x Compatibility Notes
Jekyll 3.8.x was built for older Ruby versions. Two gems were added to `Gemfile` for Ruby 3.x compatibility:
- `rexml` — removed from Ruby stdlib in 3.x, required by kramdown
- `webrick` — removed from Ruby stdlib in 3.x, required by Jekyll serve
