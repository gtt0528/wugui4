package com.wugui4.controller;

import com.wugui4.entity.User;
import com.wugui4.repo.UserRepository;
import com.wugui4.service.JwtService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.Map;
import java.util.UUID;

/** 登录：游客登录 + 微信登录（wx.login 的 code 换 openid） */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final UserRepository users;
    private final JwtService jwt;
    private final String wxAppid;
    private final String wxSecret;

    public AuthController(UserRepository users, JwtService jwt,
                          @Value("${wugui4.wx.appid}") String wxAppid,
                          @Value("${wugui4.wx.secret}") String wxSecret) {
        this.users = users;
        this.jwt = jwt;
        this.wxAppid = wxAppid;
        this.wxSecret = wxSecret;
    }

    /** 游客登录：传昵称即可。开发期和微信环境未配置时用。 */
    @PostMapping("/guest")
    public Map<String, Object> guest(@RequestBody Map<String, String> body) {
        String nickname = body.getOrDefault("nickname", "游客");
        if (nickname.isBlank()) nickname = "游客";
        if (nickname.length() > 16) nickname = nickname.substring(0, 16);

        // 同一设备重复游客登录：前端可先存上次返回的 openid 带回来，实现"同一游客"
        String openid = body.get("openid");
        User user = (openid != null && !openid.isBlank())
                ? users.findByOpenid(openid).orElse(null)
                : null;
        if (user == null) {
            user = new User();
            user.setOpenid("guest_" + UUID.randomUUID().toString().replace("-", ""));
        }
        user.setNickname(nickname);
        user.setLastLoginTime(LocalDateTime.now());
        user = users.save(user);

        return Map.of(
                "token", jwt.issue(user.getId()),
                "user", Map.of(
                        "id", user.getId(),
                        "nickname", user.getNickname(),
                        "openid", user.getOpenid()
                )
        );
    }

    /**
     * 微信登录：小程序端 wx.login() 拿 code 发过来。
     * 服务端拿 code 调微信 code2session 换 openid。
     * 未配置 appid/secret 时返回 501，提示先用游客登录。
     */
    @PostMapping("/wx")
    public ResponseEntity<Map<String, Object>> wx(@RequestBody Map<String, String> body) {
        String code = body.get("code");
        if (wxAppid.isBlank() || wxSecret.isBlank()) {
            return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                    .body(Map.of("error", "微信 appid/secret 未配置，请先用游客登录"));
        }
        if (code == null || code.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "缺少 code"));
        }

        String url = "https://api.weixin.qq.com/sns/jscode2session?appid=" + wxAppid
                + "&secret=" + wxSecret + "&js_code=" + code
                + "&grant_type=authorization_code";
        @SuppressWarnings("unchecked")
        Map<String, Object> wx = new org.springframework.web.client.RestTemplate().getForObject(url, Map.class);
        if (wx == null || wx.get("openid") == null) {
            return ResponseEntity.status(401).body(Map.of("error", "code 换 openid 失败", "wx", String.valueOf(wx)));
        }
        String openid = String.valueOf(wx.get("openid"));

        User user = users.findByOpenid(openid).orElseGet(() -> {
            User u = new User();
            u.setOpenid(openid);
            u.setNickname("玩家" + openid.substring(openid.length() - 4));
            return u;
        });
        user.setLastLoginTime(LocalDateTime.now());
        user = users.save(user);

        return ResponseEntity.ok(Map.of(
                "token", jwt.issue(user.getId()),
                "user", Map.of("id", user.getId(), "nickname", user.getNickname())
        ));
    }
}
