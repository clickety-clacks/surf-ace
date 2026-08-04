[base_dir, skill_source, executable] = Enum.reject(System.argv(), &(&1 == "--"))
identity_dir = Path.join(base_dir, "identity")

Tightbeam.Identity.init!(base_dir)

{:ok, _revision} =
  Tightbeam.Identity.learn!(base_dir, "agentic-engineering", "T1778 consumer proof")

skill_bytes = skill_source |> File.read!() |> String.trim_trailing()

Tightbeam.Identity.edit!(
  base_dir,
  "surf-ace",
  {:skill, "surf-ace", false},
  skill_bytes,
  "T1778 consumer proof"
)

for archetype <- ["coder", "reviewer"] do
  path = Path.join([identity_dir, "archetypes", "#{archetype}.toml"])
  manifest = File.read!(path)

  updated =
    Regex.replace(~r/^skills = \[(.*)\]$/m, manifest, fn _, elected ->
      suffix = if String.trim(elected) == "", do: "\"surf-ace\"", else: "#{elected}, \"surf-ace\""
      "skills = [#{suffix}]"
    end)

  Tightbeam.Identity.edit!(
    base_dir,
    archetype,
    :manifest,
    updated,
    "T1778 consumer proof"
  )
end

Tightbeam.Identity.edit!(
  base_dir,
  "future-unreleased-archetype",
  :manifest,
  ~s(name = "future-unreleased-archetype"\nskills = ["surf-ace"]\n\n[guidance]\ntext = """\n#include "wisdom-core.md"\n"""\n),
  "T1778 consumer proof"
)

digest = :crypto.hash(:sha256, File.read!(executable)) |> Base.encode16(case: :lower)
skill_digest = :crypto.hash(:sha256, skill_bytes) |> Base.encode16(case: :lower)

invoke = fn id, kind, cwd, materialized_skill ->
  File.mkdir_p!(cwd)

  {stdout, 0} =
    System.cmd(
      executable,
      [
        "--state-root",
        Path.join([base_dir, "state", id]),
        "read",
        "--input-json",
        ~s({"scopeId":"surface:proof"})
      ],
      stderr_to_stdout: false
    )

  result = JSON.decode!(stdout)
  true = result["command"] == "read"
  true = result["result"]["cacheStatus"] == "unsynchronized"

  %{
    archetype: id,
    executablePath: Path.expand(executable),
    executableSha256: digest,
    kind: kind,
    materializedSkillPath: materialized_skill,
    materializedSkillSha256: skill_digest
  }
end

direct = invoke.("direct-standalone", "standalone", base_dir, nil)

consumers =
  for archetype <- ["coder", "reviewer", "future-unreleased-archetype"] do
    cwd = Path.join([base_dir, "sessions", archetype])
    snapshot = Tightbeam.Identity.provision!(base_dir, archetype, :codex, cwd)
    true = snapshot.archetype.name == archetype
    true = List.last(snapshot.archetype.skills) == "surf-ace"
    materialized = Path.join([cwd, ".codex", "skills", "tightbeam__surf-ace", "SKILL.md"])
    true = File.read!(materialized) == skill_bytes
    invoke.(archetype, "tightbeam-skill", cwd, materialized)
  end

IO.puts(
  JSON.encode!(%{
    proof: "tightbeam-materialized-skill-identical-installed-bytes",
    records: [direct | consumers]
  })
)
