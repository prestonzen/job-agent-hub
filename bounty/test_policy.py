import unittest
import importlib.util
from pathlib import Path

from policy import explicit_prohibition, policy_decision


class PolicyDecisionTests(unittest.TestCase):
    def test_explicit_automated_scanner_ban_is_blacklisted(self):
        text = "The use of Automated scanners is strictly prohibited."
        status, evidence = policy_decision(text)
        self.assertEqual(status, "blacklisted")
        self.assertIn("strictly prohibited", evidence)

    def test_do_not_use_scanners_is_blacklisted(self):
        self.assertIsNotNone(explicit_prohibition("Do not use automated tools or scanners."))

    def test_human_only_discovery_is_blacklisted(self):
        self.assertIsNotNone(explicit_prohibition("We only accept bugs found by humans."))

    def test_prior_coordination_requirement_blocks_until_satisfied(self):
        self.assertIsNotNone(explicit_prohibition("Automated testing without prior coordination is prohibited."))

    def test_scanner_only_report_rejection_is_not_a_scan_ban(self):
        text = "Reports generated solely from automated scanners without proof are not accepted."
        self.assertEqual(policy_decision(text), ("default-allow", None))

    def test_rate_limits_do_not_blacklist(self):
        self.assertEqual(policy_decision("Automated tooling is limited to 5 requests per second."), ("default-allow", None))

    def test_scan_ban_only_for_exceeding_rate_does_not_blacklist_low_rate_run(self):
        text = "Prohibited conduct includes automated scans outside the published rate limits."
        self.assertEqual(policy_decision(text), ("default-allow", None))

    def test_unsupervised_automation_requirement_is_blacklisted_for_autonomous_schedule(self):
        text = "Automated and AI-assisted testing must be actively supervised."
        self.assertIsNotNone(explicit_prohibition(text))

    def test_unconditional_prior_approval_requirement_is_blacklisted(self):
        text = "Automated testing requires prior authorization from the program team."
        self.assertEqual(policy_decision(text)[0], "blacklisted")

    def test_automation_explicitly_not_prohibited_is_default_allow(self):
        self.assertEqual(policy_decision("Automated scanners are not prohibited."), ("default-allow", None))

    def test_ban_on_automated_account_creation_is_not_a_scan_ban(self):
        text = "Automated or scripted account creation is not allowed."
        self.assertEqual(policy_decision(text), ("default-allow", None))

    def test_plain_ai_scanning_ban_is_blacklisted(self):
        self.assertEqual(policy_decision("AI scanning is prohibited.")[0], "blacklisted")

    def test_ai_banned_only_for_report_writing_is_not_a_scan_ban(self):
        self.assertEqual(policy_decision("AI-generated reports are prohibited.")[0], "default-allow")

    def test_llm_ban_for_bug_discovery_is_blacklisted(self):
        self.assertEqual(policy_decision("LLMs are prohibited in bug discovery.")[0], "blacklisted")

    def test_custom_automation_exception_does_not_blacklist(self):
        text = "Custom tools with automated requests are allowed."
        self.assertIsNone(explicit_prohibition(text))

    def test_common_scanner_ban_is_blacklisted_even_if_custom_requests_are_allowed(self):
        text = "Do not use common scanners; custom tools with automated requests are allowed."
        self.assertIsNotNone(explicit_prohibition(text))


class ScopeTests(unittest.TestCase):
    def test_declared_executable_asset_is_not_a_web_target(self):
        from scope import asset_is_scannable
        self.assertFalse(asset_is_scannable("fortniteclient-win64-shipping.exe", "other"))
        self.assertFalse(asset_is_scannable("fortniteclient-android-shipping.apk"))

    def test_declared_web_assets_are_accepted(self):
        from scope import asset_is_scannable
        self.assertTrue(asset_is_scannable("*.example.com", "wildcard"))
        self.assertTrue(asset_is_scannable("https://example.com/api", "url"))

    def test_wildcard_stays_inside_in_scope_domain(self):
        from scope import in_scope, scope_rules
        rules = scope_rules(["*.example.com"], [])
        self.assertTrue(in_scope("api.example.com", rules))
        self.assertFalse(in_scope("example.net", rules))

    def test_exact_host_does_not_expand_to_siblings(self):
        from scope import in_scope, scope_rules
        rules = scope_rules(["api.example.com"], [])
        self.assertTrue(in_scope("api.example.com", rules))
        self.assertFalse(in_scope("sub.api.example.com", rules))

    def test_out_of_scope_exception_overrides_wildcard(self):
        from scope import in_scope, scope_rules
        rules = scope_rules(["*.example.com"], ["admin.example.com"])
        self.assertTrue(in_scope("api.example.com", rules))
        self.assertFalse(in_scope("admin.example.com", rules))

    def test_path_scoped_url_does_not_expand_to_host(self):
        from scope import in_scope, scope_rules
        rules = scope_rules(["https://example.com/specific/path"], [])
        self.assertTrue(in_scope("https://example.com/specific/path", rules))
        self.assertFalse(in_scope("https://example.com/", rules))


class CatalogFetchTests(unittest.TestCase):
    def test_catalog_fetch_requires_https_and_known_platform_host(self):
        spec = importlib.util.spec_from_file_location("scope_fetch", Path(__file__).with_name("scope-fetch.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(module.safe_fetch_url("https://hackerone.com/example"))
        self.assertTrue(module.safe_fetch_url("https://raw.githubusercontent.com/org/repo/data.json"))
        self.assertFalse(module.safe_fetch_url("http://hackerone.com/example"))
        self.assertFalse(module.safe_fetch_url("https://hackerone.com.attacker.invalid/example"))
        self.assertFalse(module.safe_fetch_url("file:///etc/passwd"))


if __name__ == "__main__":
    unittest.main()
