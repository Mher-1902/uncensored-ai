# Legal publication notes

The owner explicitly supplied the following intended-public details on October 17, 2026:

- Operator: **Mher Sukiasyan**
- Contact: **sukiasyanmher7@gmail.com**
- Operator country: **Armenia**, previously supplied.

TERMS-DRAFT.md and PRIVACY-DRAFT.md are reviewable text, not effective legal documents. Do not flip `policies_published`, create a checkbox that appears to establish compliance, or add a liability-immunity claim merely because these files exist.

The owner reconfirmed broad access on October 17 rather than selecting an adults-only pilot. Preserve that direction. The draft terms therefore describe applicable minimum-age and guardian requirements without inventing an 18+ default. The required flows and jurisdiction-specific safeguards are unfinished; that is an implementation/legal-publication dependency, not a missing answer to repeat to the owner. OpenAI's own API guidance also has separate minor-specific safeguards, but it is a comparison source, not the governing terms for this self-hosted model.

The terms include user responsibility, AI accuracy limitations and a qualified liability limitation, while preserving non-waivable rights. The owner requested a broad disclaimer; that cannot truthfully be implemented as immunity from every legal duty. The policy distinguishes a privacy acknowledgement from consent and describes the current tab-scoped session implementation honestly.

Before publication, resolve the specific remaining facts: age/guardian eligibility, final provider processing regions and retention, applicable international-transfer disclosures, and the tested contact/deletion process. Schedule and verify metadata pruning if the proposed pilot controls are activated. Reconcile the policy with the actual deployed release and get appropriate legal review for the intended markets. Do not invent a company, postal address, age verification or guaranteed protection from claims.

Publish final linked `/terms/` and `/privacy/` pages with immutable version identifiers. The planned checkbox wording is “I agree to the Terms of Use and acknowledge the Privacy Policy.” It starts unchecked. The verified account must acknowledge the current published versions through the server. Account status and age/guardian eligibility are separate checks. A future subscription needs its own explicit pricing/purchase flow.

Primary references checked October 17, 2026:

- [EDPB transparency and individuals' rights](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en): clear notice, operator identity, contact and rights. Applicability depends on the processing and markets served.
- [EU unfair contract terms guidance](https://europa.eu/youreurope/citizens/consumers/unfair-treatment/unfair-contract-terms/): consumer terms must be fair; inappropriate liability exclusions may be unenforceable.
- [Armenian law on personal data protection, official ARLIS entry](https://www.arlis.am/en/acts/117034/latest): local-law review starting point; this document does not claim a completed Armenian legal assessment.
- [European Commission on children's data](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data/are-there-any-specific-safeguards-data-about-children_en): safeguards and consent conditions cannot be replaced by an ordinary terms checkbox.
- [FTC children's privacy guidance](https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy): review applicability before accepting the proposed worldwide/all-age audience.

## October 19 current-processing notice

The signup increment adds `src/Privacy.tsx` and its generated `/privacy.html` to disclose the currently serving product before OAuth. It does not publish the older draft Terms or the staged account-control policy pair, create an acceptance receipt, enable eligibility/admission, activate metadata retention, or claim a complete legal compliance review. It explicitly identifies provider records, countries, temporary-chat limits, absent email delivery and the unavailable verified guardian flow. The final Terms/eligibility, transfer/retention and deletion/recovery work above remains required for the broader account-control launch. Keep `src/policy-documents.ts` empty until the complete versioned agreement release is ready.
