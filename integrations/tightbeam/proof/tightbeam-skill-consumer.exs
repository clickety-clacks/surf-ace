[base_dir, skill_source, executable] = Enum.reject(System.argv(), &(&1 == "--"))
identity_dir = Path.join(base_dir, "identity")

Tightbeam.Identity.init!(base_dir)

skill_destination = Path.join([identity_dir, "skills", "surf-ace", "SKILL.md"])
File.mkdir_p!(Path.dirname(skill_destination))
File.cp!(skill_source, skill_destination)

for archetype <- ["coder", "reviewer"] do
  path = Path.join([identity_dir, "archetypes", "#{archetype}.toml"])
  manifest = File.read!(path)

  updated =
    Regex.replace(~r/^skills = \[(.*)\]$/m, manifest, fn _, elected ->
      suffix = if String.trim(elected) == "", do: "\"surf-ace\"", else: "#{elected}, \"surf-ace\""
      "skills = [#{suffix}]"
    end)

  File.write!(path, updated)
end

File.write!(
  Path.join([identity_dir, "archetypes", "future-unreleased-archetype.toml"]),
  ~s(name = "future-unreleased-archetype"\nskills = ["surf-ace"]\n\n[guidance]\ntext = """\n#include "wisdom-core.md"\n"""\n)
)

git = fn args ->
  case System.cmd("git", args, cd: identity_dir, stderr_to_stdout: true) do
    {_output, 0} -> :ok
    {output, status} -> raise "git failed (#{status}): #{output}"
  end
end

git.(["add", "-A"])
git.(["-c", "user.name=T1770 proof", "-c", "user.email=t1770@invalid", "commit", "-m", "proof: elect surf-ace skill"])
git.(["branch", "-f", "tightbeam/live", "main"])

digest = :crypto.hash(:sha256, File.read!(executable)) |> Base.encode16(case: :lower)
skill_bytes = skill_source |> File.read!() |> String.trim_trailing()
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

IO.puts(JSON.encode!(%{proof: "tightbeam-materialized-skill-identical-installed-bytes", records: [direct | consumers]}))
