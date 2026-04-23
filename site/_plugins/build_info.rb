require "time"

module GeneratedArt
  REPO_URL = "https://github.com/GeneratedArt/platform".freeze
  REPO_ROOT = File.expand_path("../..", __dir__).freeze

  module_function

  def detect_sha
    ENV["CF_PAGES_COMMIT_SHA"] || ENV["GITHUB_SHA"] || begin
      sha = `git -C #{REPO_ROOT} rev-parse HEAD 2>/dev/null`.strip
      sha.empty? ? nil : sha
    end
  end

  def detect_branch
    ENV["CF_PAGES_BRANCH"] || ENV["GITHUB_REF_NAME"] || begin
      branch = `git -C #{REPO_ROOT} rev-parse --abbrev-ref HEAD 2>/dev/null`.strip
      branch.empty? ? nil : branch
    end
  end
end

Jekyll::Hooks.register :site, :after_init do |site|
  sha = GeneratedArt.detect_sha
  built_at = Time.now.utc.iso8601

  if sha && !sha.empty?
    site.config["build"] = {
      "commit_short" => sha[0, 7],
      "commit_long" => sha,
      "commit_url" => "#{GeneratedArt::REPO_URL}/commit/#{sha}",
      "branch" => GeneratedArt.detect_branch,
      "built_at" => built_at,
      "repo_url" => GeneratedArt::REPO_URL,
    }
  else
    site.config["build"] = {
      "commit_short" => "dev",
      "commit_url" => GeneratedArt::REPO_URL,
      "built_at" => built_at,
      "repo_url" => GeneratedArt::REPO_URL,
    }
  end
end
