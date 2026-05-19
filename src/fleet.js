const path = require('path');

class Fleet {
  constructor(knowledge) {
    this.knowledge = knowledge;
  }

  /**
   * Extract lessons from a worker handover markdown and ingest into knowledge store.
   * Returns the number of lessons ingested.
   */
  ingestHandover(markdownContent, workerId) {
    const lessons = this._extractLessons(markdownContent);
    if (lessons.length === 0) return 0;

    for (const lesson of lessons) {
      this.knowledge.annotate({
        target: lesson.target || 'global',
        note: lesson.text,
        author: workerId,
        tags: ['lesson', 'handover'],
      });
    }

    return lessons.length;
  }

  _extractLessons(markdown) {
    const lessons = [];

    // Find "Lessons Learned" or "What We Learned" section
    const sectionPattern = /^##\s+(Lessons\s+Learned|What\s+We\s+Learned|Key\s+Learnings?)\s*$/im;
    const match = markdown.match(sectionPattern);
    if (!match) return lessons;

    const startIdx = markdown.indexOf(match[0]) + match[0].length;
    const rest = markdown.substring(startIdx);

    // Extract until next ## heading or end of file
    const nextSection = rest.search(/^##\s+/m);
    const section = nextSection > 0 ? rest.substring(0, nextSection) : rest;

    // Parse bullet points
    const bulletPattern = /^[-*]\s+(.+)$/gm;
    let bulletMatch;
    while ((bulletMatch = bulletPattern.exec(section)) !== null) {
      const text = bulletMatch[1].trim();
      if (text.length < 5) continue; // Skip trivially short bullets

      // Try to extract file target from the lesson text
      const fileMatch = text.match(/\b(\w+\/[\w./]+\.\w+)\b/);
      lessons.push({
        text,
        target: fileMatch ? fileMatch[1] : 'global',
      });
    }

    return lessons;
  }

  /**
   * Generate a fleet-wide learning report.
   */
  learningReport() {
    const all = this.knowledge.all();
    const lessons = all.filter((e) => (e.tags || []).includes('lesson'));
    const patterns = all.filter((e) => (e.tags || []).includes('pattern'));
    const warnings = all.filter((e) => (e.tags || []).includes('warning'));

    const byAuthor = {};
    for (const entry of all) {
      const author = entry.author || 'unknown';
      byAuthor[author] = (byAuthor[author] || 0) + 1;
    }

    const byTarget = {};
    for (const entry of all) {
      const target = entry.target || 'global';
      byTarget[target] = (byTarget[target] || 0) + 1;
    }

    return {
      totalAnnotations: all.length,
      lessonCount: lessons.length,
      patternCount: patterns.length,
      warningCount: warnings.length,
      byAuthor,
      byTarget,
      recentLessons: lessons.slice(-10),
    };
  }

  /**
   * Generate MCP server config for cortex-engine (used by conductor dispatch).
   */
  getMcpConfig(projectRoot) {
    const serverPath = path.resolve(__dirname, 'server.js');
    return {
      command: 'node',
      args: [serverPath, projectRoot],
      env: {},
    };
  }
}

module.exports = Fleet;
