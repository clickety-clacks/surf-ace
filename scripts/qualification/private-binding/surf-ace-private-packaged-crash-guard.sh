#!/usr/bin/env bash
set -euo pipefail

# Qualification only. This guard never launches the app or changes client state;
# it creates fresh package trees under a disposable fixture home.
root=/tmp/surf-ace-private-crash-fixture-inputs
home=${1:?expected disposable fixture home}
runtime=${2:?expected private XDG_RUNTIME_DIR}
socket=${3:?expected private Weston socket name}

fail() { printf 'guard_failed=%s\n' "$1" >&2; exit 1; }
[[ $(id -un) == mike ]] || fail wrong_user
[[ -d $root && ! -L $root ]] || fail fixture_root_missing
[[ $(stat -c %a "$root") == 700 ]] || fail fixture_root_permissions
[[ -d $home && ! -L $home ]] || fail disposable_home_missing
[[ $(dirname "$(realpath -e "$home")") == "$root" ]] || fail home_outside_fixture_root
[[ $(stat -c %a "$home") == 700 ]] || fail home_permissions

user_data=$home/user-data
[[ -d $user_data && ! -L $user_data ]] || fail user_data_missing
[[ $(realpath -e "$user_data") == "$home/user-data" ]] || fail user_data_path
[[ $(stat -c %a "$user_data") == 700 ]] || fail user_data_permissions
[[ ! -e $home/stop.marker ]] || fail old_stop_marker
[[ ! -e $home/stop.marker.tmp ]] || fail old_stop_marker
[[ -f $user_data/surface-core-state.json && -f $user_data/surface-core-state.json.selector ]] || fail state_missing

check_hash() {
  local expected=$1 file=$2 actual
  [[ -f $file && ! -L $file ]] || fail input_missing
  actual=$(sha256sum "$file")
  [[ ${actual%% *} == "$expected" ]] || fail input_hash_mismatch
}
check_hash b96e22f184a041b99901484fd09ea0f19e6427017d7112598f948f8ca1d51398 "$root/surf-ace-electron-linux-x86_64-v0.2.6.zip"
check_hash f0623c165a90ed2c93a8c61b17243cab5907e70e3fe5e93531d1b887ca5094f3 "$root/surf-ace-tightbeam-electron-linux-x86_64-v0.2.5.zip"
check_hash 257be94a336af7710af4997248f9d24410bbde74cd10565cb01d064e6838b723 "$user_data/surface-core-state.json"
check_hash 4e41a483ef5f755832c000e6b0d2eb95a98cdd49a4c94730edd6b701bfa474f7 "$user_data/surface-core-state.json.selector"

[[ -z $(ip -4 route show default) && -z $(ip -6 route show default) ]] || fail default_route_present
[[ -z $(ip -o -4 addr show scope global) && -z $(ip -o -6 addr show scope global) ]] || fail global_interface_present
[[ $(realpath -m "$runtime") == "$home/runtime" && -d $runtime && ! -L $runtime ]] || fail runtime_path
[[ $(stat -c %a "$runtime") == 700 ]] || fail runtime_permissions
[[ $socket == surf-ace-private-* && $socket != */* ]] || fail socket_name
[[ -S $runtime/$socket ]] || fail private_weston_socket_missing

# Nothing under the old staged extraction is executable evidence. Extract the
# already hash-checked archives afresh for this one disposable home, and pass
# only these paths to the eventual launcher. Existing directories fail closed.
pr61_tree=$home/package-pr61
r4_tree=$home/package-r4
[[ ! -e $pr61_tree && ! -L $pr61_tree && ! -e $r4_tree && ! -L $r4_tree ]] || fail package_tree_not_fresh
mkdir -m 700 "$pr61_tree" "$r4_tree"
unzip -q "$root/surf-ace-electron-linux-x86_64-v0.2.6.zip" -d "$pr61_tree" || fail pr61_extract_failed
unzip -q "$root/surf-ace-tightbeam-electron-linux-x86_64-v0.2.5.zip" -d "$r4_tree" || fail r4_extract_failed
pr61_binary=$pr61_tree/Surf\ Ace/surf-ace
r4_binary=$r4_tree/Surf\ Ace/surf-ace
[[ -x $pr61_binary && ! -L $pr61_binary && -x $r4_binary && ! -L $r4_binary ]] || fail fresh_package_binary_missing

# The eventual launch must use these exact values; the app must independently
# log matching state_dir before any one-shot stop can be armed.
launch_user_data_arg="--user-data-dir=$user_data"
fault_target_dir=$user_data
[[ ${launch_user_data_arg#--user-data-dir=} == "$fault_target_dir" ]] || fail target_mismatch
printf 'guard_passed=true\nfixture_home=%s\nuser_data=%s\nprivate_socket=%s\npr61_binary=%s\nr4_binary=%s\n' \
  "$home" "$user_data" "$runtime/$socket" "$pr61_binary" "$r4_binary"
