package com.wugui4.controller;

import com.wugui4.entity.MatchPlayer;
import com.wugui4.entity.MatchRecord;
import com.wugui4.entity.User;
import com.wugui4.repo.MatchPlayerRepository;
import com.wugui4.repo.MatchRecordRepository;
import com.wugui4.repo.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 对局记录：上报（真人/游戏服均可）与查询、排行 */
@RestController
@RequestMapping("/api")
public class MatchController {

    private final MatchRecordRepository matches;
    private final MatchPlayerRepository players;
    private final UserRepository users;

    public MatchController(MatchRecordRepository matches, MatchPlayerRepository players, UserRepository users) {
        this.matches = matches;
        this.players = players;
        this.users = users;
    }

    /**
     * 上报一局结果。
     * 单机模式：玩家本人带 JWT 调用，players 里最多带自己一条。
     * 联机模式：gameserver 带 X-Internal-Token 调用，players 带 4 条。
     */
    @PostMapping("/matches")
    public ResponseEntity<?> report(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        boolean internal = Boolean.TRUE.equals(req.getAttribute("internal"));
        Long me = (Long) req.getAttribute("userId");

        String mode = String.valueOf(body.getOrDefault("mode", internal ? "ONLINE" : "LOCAL"));
        Integer rounds = body.get("totalRounds") instanceof Integer n ? n : 1;
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) body.get("players");
        if (list == null || list.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "缺少 players"));
        }
        // 非内部调用只允许上报自己
        if (!internal && list.size() > 1) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "只有服务器可批量上报"));
        }

        MatchRecord rec = new MatchRecord();
        rec.setMode(mode);
        rec.setTotalRounds(rounds);
        rec = matches.save(rec);

        List<Long> saved = new ArrayList<>();
        for (Map<String, Object> p : list) {
            MatchPlayer mp = new MatchPlayer();
            mp.setMatchId(rec.getId());
            mp.setUserId(((Number) p.get("userId")).longValue());
            mp.setSeat(p.get("seat") instanceof Number s ? s.intValue() : 0);
            mp.setResult(String.valueOf(p.getOrDefault("result", "LOSE")));
            mp.setScore(p.get("score") instanceof Number s2 ? s2.intValue() : 0);
            // 更新用户累计
            users.findById(mp.getUserId()).ifPresent(u -> {
                u.setTotalGames(u.getTotalGames() + 1);
                if ("WIN".equals(mp.getResult())) u.setTotalWins(u.getTotalWins() + 1);
                users.save(u);
            });
            saved.add(players.save(mp).getId());
        }
        return ResponseEntity.ok(Map.of("matchId", rec.getId(), "playerIds", saved));
    }

    /** 我的最近对局 */
    @GetMapping("/matches/me")
    public List<Map<String, Object>> myMatches(HttpServletRequest req, @RequestParam(defaultValue = "20") int limit) {
        Long me = (Long) req.getAttribute("userId");
        Pageable page = PageRequest.of(0, Math.min(Math.max(limit, 1), 100));
        List<Map<String, Object>> out = new ArrayList<>();
        for (MatchPlayer mp : players.findByUserIdOrderByIdDesc(me, page)) {
            out.add(Map.of(
                    "matchId", mp.getMatchId(),
                    "seat", mp.getSeat(),
                    "result", mp.getResult(),
                    "score", mp.getScore(),
                    "time", String.valueOf(mp.getCreateTime())
            ));
        }
        return out;
    }

    /** 胜场排行榜 */
    @GetMapping("/rank")
    public List<Map<String, Object>> rank(@RequestParam(defaultValue = "20") int limit) {
        Pageable page = PageRequest.of(0, Math.min(Math.max(limit, 1), 100));
        List<Map<String, Object>> out = new ArrayList<>();
        int i = 1;
        for (Object[] row : players.rankByWins(page)) {
            Long userId = (Long) row[0];
            Long wins = (Long) row[1];
            String nickname = users.findById(userId).map(User::getNickname).orElse("未知");
            out.add(Map.of("rank", i++, "userId", userId, "nickname", nickname, "wins", wins));
        }
        return out;
    }

    /** 我的信息 */
    @GetMapping("/users/me")
    public Map<String, Object> me(HttpServletRequest req) {
        Long me = (Long) req.getAttribute("userId");
        User u = users.findById(me).orElseThrow();
        return Map.of(
                "id", u.getId(),
                "nickname", u.getNickname(),
                "gender", u.getGender(),
                "avatar", u.getAvatar() == null ? "" : u.getAvatar(),
                "totalGames", u.getTotalGames(),
                "totalWins", u.getTotalWins()
        );
    }

    /** 修改资料：昵称 / 性别 / 头像（任选字段传） */
    @PutMapping("/users/me")
    public Map<String, Object> updateMe(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        Long me = (Long) req.getAttribute("userId");
        User u = users.findById(me).orElseThrow();

        if (body.containsKey("nickname")) {
            String nick = String.valueOf(body.get("nickname")).trim();
            if (nick.isEmpty() || nick.length() > 16) {
                throw new IllegalArgumentException("昵称要 1~16 个字");
            }
            u.setNickname(nick);
        }
        if (body.containsKey("gender")) {
            int g = ((Number) body.get("gender")).intValue();
            if (g < 0 || g > 2) throw new IllegalArgumentException("性别取值 0/1/2");
            u.setGender(g);
        }
        if (body.containsKey("avatar")) {
            String avatar = String.valueOf(body.get("avatar"));
            if (avatar.length() > 60000) throw new IllegalArgumentException("头像太大");
            u.setAvatar(avatar.equals("null") ? "" : avatar);
        }
        users.save(u);
        return Map.of(
                "id", u.getId(),
                "nickname", u.getNickname(),
                "gender", u.getGender(),
                "avatar", u.getAvatar() == null ? "" : u.getAvatar()
        );
    }
}
