//! Local Full-Text Search Engine & Match Navigator.
//!
//! Indexes extracted PDF page text locally in memory without any external network calls,
//! detects scanned documents lacking an embedded text layer, and navigates matches.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub match_index: usize,
    pub page_number: u32,
    pub page_match_index: usize,
    pub char_start: usize,
    pub char_len: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchQueryResult {
    pub query: String,
    pub total_matches: usize,
    pub has_searchable_text: bool,
    pub active_match_index: Option<usize>,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Default)]
pub struct DocumentTextIndex {
    /// 1-based page number -> extracted text string
    pub pages: BTreeMap<u32, String>,
}

impl DocumentTextIndex {
    pub fn from_pages(pages: BTreeMap<u32, String>) -> Self {
        Self { pages }
    }

    /// Returns `true` if the document contains any non-whitespace searchable text layer.
    pub fn has_searchable_text(&self) -> bool {
        self.pages
            .values()
            .any(|text| text.chars().any(|c| !c.is_whitespace()))
    }

    /// Searches across all pages in ascending page order.
    pub fn search(&self, query: &str, case_sensitive: bool) -> SearchQueryResult {
        let has_searchable_text = self.has_searchable_text();
        let trimmed = query.trim();
        if trimmed.is_empty() || !has_searchable_text {
            return SearchQueryResult {
                query: query.to_string(),
                total_matches: 0,
                has_searchable_text,
                active_match_index: None,
                matches: Vec::new(),
            };
        }

        let needle = if case_sensitive {
            trimmed.to_string()
        } else {
            trimmed.to_lowercase()
        };

        let mut matches = Vec::new();
        let mut global_idx = 0usize;

        for (&page_number, page_text) in &self.pages {
            let haystack = if case_sensitive {
                page_text.clone()
            } else {
                page_text.to_lowercase()
            };

            let mut search_from = 0usize;
            let mut page_match_idx = 0usize;

            while search_from < haystack.len() {
                if let Some(rel_pos) = haystack[search_from..].find(&needle) {
                    let abs_byte_pos = search_from + rel_pos;
                    let char_start = haystack[..abs_byte_pos].chars().count();
                    let char_len = needle.chars().count();

                    // Build human-readable context snippet around match
                    let chars: Vec<char> = page_text.chars().collect();
                    let ctx_start = char_start.saturating_sub(28);
                    let ctx_end = (char_start + char_len + 36).min(chars.len());
                    let mut snippet: String = chars[ctx_start..ctx_end].iter().collect();
                    snippet = snippet.replace(['\r', '\n', '\t'], " ");
                    if ctx_start > 0 {
                        snippet = format!("…{}", snippet);
                    }
                    if ctx_end < chars.len() {
                        snippet.push('…');
                    }

                    matches.push(SearchMatch {
                        match_index: global_idx,
                        page_number,
                        page_match_index: page_match_idx,
                        char_start,
                        char_len,
                        snippet,
                    });

                    global_idx += 1;
                    page_match_idx += 1;
                    search_from = abs_byte_pos + needle.len().max(1);
                } else {
                    break;
                }
            }
        }

        let total_matches = matches.len();
        let active_match_index = if total_matches > 0 { Some(0) } else { None };

        SearchQueryResult {
            query: query.to_string(),
            total_matches,
            has_searchable_text,
            active_match_index,
            matches,
        }
    }

    /// Computes the next or previous active match index with wrap-around.
    pub fn step_match(total_matches: usize, current: usize, forward: bool) -> Option<usize> {
        if total_matches == 0 {
            return None;
        }
        if forward {
            Some((current + 1) % total_matches)
        } else if current == 0 {
            Some(total_matches - 1)
        } else {
            Some(current - 1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_case_insensitive_search_and_navigation() {
        let mut pages = BTreeMap::new();
        pages.insert(
            1,
            "Eigenvalues and Eigenvectors in Linear Algebra.".to_string(),
        );
        pages.insert(2, "No relevant keyword on this page.".to_string());
        pages.insert(
            3,
            "Computing the dominant eigenvalue by power iteration.".to_string(),
        );

        let idx = DocumentTextIndex::from_pages(pages);
        assert!(idx.has_searchable_text());

        let res = idx.search("EIGENVALUE", false);
        assert_eq!(res.total_matches, 2);
        assert_eq!(res.matches[0].page_number, 1);
        assert_eq!(res.matches[1].page_number, 3);

        // Wrap-around navigation
        assert_eq!(DocumentTextIndex::step_match(2, 0, true), Some(1));
        assert_eq!(DocumentTextIndex::step_match(2, 1, true), Some(0));
        assert_eq!(DocumentTextIndex::step_match(2, 0, false), Some(1));
    }

    #[test]
    fn test_scanned_document_without_text_detection() {
        let mut pages = BTreeMap::new();
        pages.insert(1, "   \n  ".to_string());
        pages.insert(2, "".to_string());
        let idx = DocumentTextIndex::from_pages(pages);
        assert!(!idx.has_searchable_text());
        let res = idx.search("theorem", false);
        assert!(!res.has_searchable_text);
        assert_eq!(res.total_matches, 0);
    }
}
